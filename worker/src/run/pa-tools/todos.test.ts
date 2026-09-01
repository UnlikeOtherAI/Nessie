import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import { PrismaClient } from '@prisma/client'
import { parseOrganizationId } from '@nessie/schemas'
import { updateAgentTodoStep } from '@nessie/workspace-admin'

import type { BuiltinToolRuntimeContext, ToolExecutionResult } from '../tool-types.js'
import { executeBuiltinTool } from '../tools.js'
import {
  runTodoStartTool,
  runTodoStepUpdateTool,
  runTodoTemplateProposeTool,
} from './todos.js'
import { createConsumedSourceSink } from '../execute/disclosure-basis.js'

const dbTest = process.env.DATABASE_URL ? test : test.skip

type TodoToolFixture = {
  agentId: string
  channelId: string
  otherAgentId: string
  organizationId: string
  threadId: string
}

const createFixture = async (prisma: PrismaClient): Promise<TodoToolFixture> => {
  const agentId = randomUUID()
  const channelId = randomUUID()
  const organizationId = randomUUID()
  const projectId = randomUUID()
  const teamId = randomUUID()
  const threadId = randomUUID()

  await prisma.organization.create({
    data: { id: organizationId, name: `todo-tool-${organizationId}` },
  })
  await prisma.project.create({
    data: { id: projectId, name: 'To-do tool project', organizationId },
  })
  await prisma.team.create({
    data: { id: teamId, name: 'To-do tool team', projectId },
  })
  await prisma.channel.create({
    data: {
      id: channelId,
      label: 'todo-tool-channel',
      organizationId,
      projectId,
      slug: `todo-tool-${channelId.slice(0, 8)}`,
      teamId,
      visibility: 'private',
    },
  })
  await prisma.thread.create({
    data: { channelId, id: threadId, title: 'To-do tool thread' },
  })
  const otherAgentId = randomUUID()
  await prisma.agent.create({
    data: { id: agentId, name: 'To-do tool agent', organizationId, todosEnabled: true },
  })
  await prisma.agent.create({
    data: {
      id: otherAgentId,
      name: 'Other to-do tool agent',
      organizationId,
      todosEnabled: true,
    },
  })

  return { agentId, channelId, otherAgentId, organizationId, threadId }
}

const cleanupFixture = async (prisma: PrismaClient, fixture: TodoToolFixture): Promise<void> => {
  await prisma.organization.delete({ where: { id: fixture.organizationId } })
}

const withDatabase = async (
  run: (prisma: PrismaClient, fixture: TodoToolFixture) => Promise<void>,
): Promise<void> => {
  const prisma = new PrismaClient()
  let fixture: TodoToolFixture | undefined
  try {
    fixture = await createFixture(prisma)
    await run(prisma, fixture)
  } finally {
    if (fixture) await cleanupFixture(prisma, fixture)
    await prisma.$disconnect()
  }
}

const contextFor = (
  prisma: PrismaClient,
  fixture: TodoToolFixture,
  runId: string,
  agentId = fixture.agentId,
): BuiltinToolRuntimeContext => ({
  actorContext: {
    actionContext: { requestId: `todo-tool-${runId}` },
    actor: { actorId: randomUUID(), actorType: 'user' },
    tenant: { organizationId: parseOrganizationId(fixture.organizationId) },
  },
  agentId,
  agentKind: 'shared',
  channel: { id: fixture.channelId, organizationId: parseOrganizationId(fixture.organizationId) },
  ledgerIdentity: null,
  prisma,
  realtimeTransport: {
    publishWs: async () => undefined,
  } as unknown as BuiltinToolRuntimeContext['realtimeTransport'],
  run: { id: runId, messageId: randomUUID(), threadId: fixture.threadId },
  toolCallId: null,
})

const createRun = async (
  prisma: PrismaClient,
  fixture: TodoToolFixture,
  status: 'completed' | 'running' = 'running',
  agentId = fixture.agentId,
): Promise<string> => {
  const run = await prisma.run.create({
    data: { agentId, status, threadId: fixture.threadId },
  })
  return run.id
}

const checklist = (result: ToolExecutionResult) => JSON.parse(result.outputPreview) as {
  activeRunId: string | null
  id: string
  steps: Array<{ instructions: string; key: string; status: string; title: string }>
}

const TODO_START_MODE_MESSAGE =
  'Start exactly one to-do: provide templateId, todoId, or both title and steps.'

dbTest('todo_start gives one concurrent claimant the verbatim checklist and gives the loser no steps', async () => {
  await withDatabase(async (prisma, fixture) => {
    const firstRunId = await createRun(prisma, fixture)
    const secondRunId = await createRun(prisma, fixture)
    const todo = await prisma.agentTodo.create({
      data: {
        agentId: fixture.agentId,
        organizationId: fixture.organizationId,
        steps: {
          create: [
            {
              instructions: 'No resumas este paso, porfa.',
              key: 'verbatim-step',
              sequence: 0,
              title: 'Revisa el feedback, tío',
            },
          ],
        },
        title: 'Checklist concurrente',
      },
    })

    const outcomes = await Promise.allSettled([
      runTodoStartTool(contextFor(prisma, fixture, firstRunId), { todoId: todo.id }),
      runTodoStartTool(contextFor(prisma, fixture, secondRunId), { todoId: todo.id }),
    ])
    const winner = outcomes.find(
      (outcome): outcome is PromiseFulfilledResult<ToolExecutionResult> =>
        outcome.status === 'fulfilled',
    )
    const loser = outcomes.find(
      (outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected',
    )

    assert.ok(winner, 'one run must claim the to-do')
    assert.ok(loser, 'the competing run must be refused')
    assert.match(String(loser.reason), /already being worked/)
    assert.doesNotMatch(String(loser.reason), /Revisa el feedback/)

    const returned = checklist(winner.value)
    assert.deepEqual(returned.steps.map(({ instructions, key, status, title }) => ({
      instructions,
      key,
      status,
      title,
    })), [
      {
        instructions: 'No resumas este paso, porfa.',
        key: 'verbatim-step',
        status: 'pending',
        title: 'Revisa el feedback, tío',
      },
    ])
    assert.ok([firstRunId, secondRunId].includes(returned.activeRunId ?? ''))
  })
})

dbTest('todo_start can reclaim a to-do whose active run is terminal', async () => {
  await withDatabase(async (prisma, fixture) => {
    const terminalRunId = await createRun(prisma, fixture, 'completed')
    const currentRunId = await createRun(prisma, fixture)
    const todo = await prisma.agentTodo.create({
      data: {
        activeRunId: terminalRunId,
        agentId: fixture.agentId,
        organizationId: fixture.organizationId,
        steps: {
          create: [{ instructions: 'Pick up the stale item.', key: 'resume', sequence: 0, title: 'Resume' }],
        },
        title: 'Stale claim',
      },
    })

    const result = await runTodoStartTool(
      contextFor(prisma, fixture, currentRunId),
      { todoId: todo.id },
    )

    assert.equal(checklist(result).activeRunId, currentRunId)
  })
})

dbTest('todo tools refuse a to-do that belongs to a different agent', async () => {
  await withDatabase(async (prisma, fixture) => {
    const otherRunId = await createRun(prisma, fixture, 'running', fixture.otherAgentId)
    const context = contextFor(prisma, fixture, otherRunId, fixture.otherAgentId)
    const todo = await prisma.agentTodo.create({
      data: {
        agentId: fixture.agentId,
        organizationId: fixture.organizationId,
        steps: {
          create: [{ instructions: 'Keep this private to its agent.', key: 'owned', sequence: 0, title: 'Owned' }],
        },
        title: 'Other agent to-do',
      },
    })

    await assert.rejects(
      () => runTodoStartTool(context, { todoId: todo.id }),
      /To-do not found/,
    )

    // Deliberately make the run pointer match. This isolates the agentId
    // predicate from the independent run-ownership predicate.
    await prisma.agentTodo.update({
      data: { activeRunId: otherRunId, status: 'running' },
      where: { id: todo.id },
    })
    await assert.rejects(
      () => runTodoStepUpdateTool(context, {
        status: 'completed',
        stepKey: 'owned',
        todoId: todo.id,
      }),
      /not actively owned by this run/,
    )
  })
})

dbTest('todo_start copies an active template verbatim and protects its instance claim', async () => {
  await withDatabase(async (prisma, fixture) => {
    const templateSteps = [
      { instructions: 'Reúne las novedades sin resumirlas.', key: 'collect', title: 'Reúne novedades' },
      { instructions: 'Comparte el resultado con el equipo.', key: 'share', title: 'Comparte resultado' },
    ]
    const template = await prisma.agentTodoTemplate.create({
      data: {
        agentId: fixture.agentId,
        authorType: 'user',
        name: 'Informe semanal',
        organizationId: fixture.organizationId,
        status: 'active',
        steps: templateSteps,
      },
    })
    const firstRunId = await createRun(prisma, fixture)
    const started = await runTodoStartTool(
      contextFor(prisma, fixture, firstRunId),
      { templateId: template.id },
    )
    const returned = checklist(started)

    assert.deepEqual(returned.steps.map(({ instructions, key, title }) => ({
      instructions,
      key,
      title,
    })), templateSteps)

    const secondRunId = await createRun(prisma, fixture)
    await assert.rejects(
      () => runTodoStartTool(contextFor(prisma, fixture, secondRunId), { todoId: returned.id }),
      /already being worked/,
    )
  })
})

dbTest('todo_start refuses another to-do after this run already claimed one', async () => {
  await withDatabase(async (prisma, fixture) => {
    const runId = await createRun(prisma, fixture)
    const context = contextFor(prisma, fixture, runId)
    await runTodoStartTool(context, {
      steps: [{ instructions: 'Do the first thing.', key: 'first', title: 'First task' }],
      title: 'First to-do',
    })

    await assert.rejects(
      () => runTodoStartTool(context, {
        steps: [{ instructions: 'Do the second thing.', key: 'second', title: 'Second task' }],
        title: 'Second to-do',
      }),
      /already working on "First to-do"/,
    )
  })
})

dbTest('todo_step_update refuses a run that does not own the live to-do', async () => {
  await withDatabase(async (prisma, fixture) => {
    const ownerRunId = await createRun(prisma, fixture)
    const otherRunId = await createRun(prisma, fixture)
    const started = await runTodoStartTool(
      contextFor(prisma, fixture, ownerRunId),
      {
        steps: [{ instructions: 'Work the task.', key: 'work', title: 'Work' }],
        title: 'Owned to-do',
      },
    )

    await assert.rejects(
      () => runTodoStepUpdateTool(contextFor(prisma, fixture, otherRunId), {
        status: 'completed',
        stepKey: 'work',
        todoId: checklist(started).id,
      }),
      /not actively owned by this run/,
    )
  })
})

dbTest('todo_step_update returns the current full checklist after a human changes another step', async () => {
  await withDatabase(async (prisma, fixture) => {
    const runId = await createRun(prisma, fixture)
    const context = contextFor(prisma, fixture, runId)
    const started = await runTodoStartTool(context, {
      steps: [
        { instructions: 'Agent work.', key: 'agent-work', title: 'Agent work' },
        { instructions: 'Human sign-off.', key: 'human-sign-off', title: 'Human sign-off' },
      ],
      title: 'Shared to-do',
    })
    const todoId = checklist(started).id

    await updateAgentTodoStep(prisma, {
      actor: { id: randomUUID(), type: 'user' },
      agentId: fixture.agentId,
      key: 'human-sign-off',
      organizationId: fixture.organizationId,
      status: 'completed',
      todoId,
    })
    const updated = await runTodoStepUpdateTool(context, {
      status: 'running',
      stepKey: 'agent-work',
      todoId,
    })

    assert.deepEqual(
      checklist(updated).steps.map((step) => ({ key: step.key, status: step.status })),
      [
        { key: 'agent-work', status: 'running' },
        { key: 'human-sign-off', status: 'completed' },
      ],
    )
  })
})

test('todo_start gives the model one legible refusal when its mode is ambiguous', async () => {
  for (const input of [
    {},
    { templateId: randomUUID(), todoId: randomUUID() },
  ]) {
    const result = await executeBuiltinTool(
      'todo_start',
      input,
      {} as BuiltinToolRuntimeContext,
    )

    assert.equal(result.success, false)
    assert.equal(result.output, `Tool error: ${TODO_START_MODE_MESSAGE}`)
  }
})

dbTest('todo_template_propose creates an agent draft and owner-only approval in one transaction', async () => {
  await withDatabase(async (prisma, fixture) => {
    const runId = await createRun(prisma, fixture)
    const result = await runTodoTemplateProposeTool(contextFor(prisma, fixture, runId), {
      description: 'Repetitive QA checks.',
      name: 'QA checklist',
      steps: [{ instructions: 'Check the deployed route.', title: 'Check route' }],
    })
    assert.match(result.outputPreview, /owner review/)
    const template = await prisma.agentTodoTemplate.findFirstOrThrow({
      where: { agentId: fixture.agentId, proposedByRunId: runId },
    })
    assert.equal(template.authorType, 'agent')
    assert.equal(template.status, 'draft')
    const approval = await prisma.approvalRequest.findFirstOrThrow({
      where: { action: 'agent.todo_template.publish', agentId: fixture.agentId },
    })
    assert.equal(approval.requesterId, fixture.agentId)
    assert.equal(approval.requiredApproverRole, 'owner')
    assert.deepEqual(approval.context, { templateId: template.id, version: template.version })
  })
})

dbTest('todo_template_propose refuses a run that consumed a scoped source', async () => {
  await withDatabase(async (prisma, fixture) => {
    const runId = await createRun(prisma, fixture)
    const context = contextFor(prisma, fixture, runId)
    const consumedSources = createConsumedSourceSink()
    consumedSources.add({ scopeId: randomUUID(), scopeType: 'user' })
    context.consumedSources = consumedSources
    await assert.rejects(
      () => runTodoTemplateProposeTool(context, {
        name: 'Do not launder',
        steps: [{ instructions: 'This stays out.', title: 'Stay out' }],
      }),
      /drew on restricted material/,
    )
    assert.equal(await prisma.agentTodoTemplate.count({ where: { proposedByRunId: runId } }), 0)
  })
})

dbTest('todo_template_propose refuses the eleventh pending proposal', async () => {
  await withDatabase(async (prisma, fixture) => {
    const runId = await createRun(prisma, fixture)
    await prisma.approvalRequest.createMany({
      data: Array.from({ length: 10 }, () => ({
        action: 'agent.todo_template.publish',
        agentId: fixture.agentId,
        continuationToken: randomUUID(),
        expiresAt: new Date(Date.now() + 86_400_000),
        organizationId: fixture.organizationId,
        reason: 'pending proposal',
        requesterId: fixture.agentId,
        runId,
        status: 'pending' as const,
      })),
    })
    await assert.rejects(
      () => runTodoTemplateProposeTool(contextFor(prisma, fixture, runId), {
        name: 'Number eleven',
        steps: [{ instructions: 'Must not write.', title: 'Refuse' }],
      }),
      /10 to-do template proposals/,
    )
  })
})
