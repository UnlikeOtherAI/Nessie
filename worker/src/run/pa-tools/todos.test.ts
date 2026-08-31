import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import { PrismaClient } from '@prisma/client'
import { parseOrganizationId } from '@nessie/schemas'
import { updateAgentTodoStep } from '@nessie/workspace-admin'

import type { BuiltinToolRuntimeContext, ToolExecutionResult } from '../tool-types.js'
import { runTodoStartTool, runTodoStepUpdateTool } from './todos.js'

const dbTest = process.env.DATABASE_URL ? test : test.skip

type TodoToolFixture = {
  agentId: string
  channelId: string
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
  await prisma.agent.create({
    data: { id: agentId, name: 'To-do tool agent', organizationId, todosEnabled: true },
  })

  return { agentId, channelId, organizationId, threadId }
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
): BuiltinToolRuntimeContext => ({
  actorContext: {
    actionContext: { requestId: `todo-tool-${runId}` },
    actor: { actorId: randomUUID(), actorType: 'user' },
    tenant: { organizationId: parseOrganizationId(fixture.organizationId) },
  },
  agentId: fixture.agentId,
  agentKind: 'shared',
  channel: { id: fixture.channelId, organizationId: parseOrganizationId(fixture.organizationId) },
  ledgerIdentity: null,
  prisma,
  realtimeTransport: {} as BuiltinToolRuntimeContext['realtimeTransport'],
  run: { id: runId, messageId: randomUUID(), threadId: fixture.threadId },
  toolCallId: null,
})

const createRun = async (
  prisma: PrismaClient,
  fixture: TodoToolFixture,
  status: 'completed' | 'running' = 'running',
): Promise<string> => {
  const run = await prisma.run.create({
    data: { agentId: fixture.agentId, status, threadId: fixture.threadId },
  })
  return run.id
}

const checklist = (result: ToolExecutionResult) => JSON.parse(result.outputPreview) as {
  activeRunId: string | null
  id: string
  steps: Array<{ instructions: string; key: string; status: string; title: string }>
}

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
