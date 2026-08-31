import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import { PrismaClient } from '@prisma/client'
import {
  AGENT_TODO_STEP_NOTE_MAX,
  type AgentTodoRecord,
  type AgentTodoTemplateRecord,
} from '@nessie/schemas'
import {
  AGENT_TODO_ERROR_CODES,
  AgentTodoError,
  activateAgentTodoTemplate,
  claimAgentTodoForRun,
  createAgentTodoTemplate,
  createStandaloneAgentTodo,
  getAgentTodo,
  updateAgentTodoStep,
} from '@nessie/workspace-admin'
import { requestRunCancellation } from '../src/services/runs.js'
import { runApprovalEffect } from '../src/services/approval-effects.js'
import { actorContextFor } from './agent-todo-route-fixture.js'
import type { FastifyInstance, LightMyRequestResponse } from 'fastify'

import {
  activeTemplatePayload,
  cleanupAgentTodoRoutes,
  createAgentTodoRouteApp,
  seedAgentTodoRoutes,
  type AgentTodoRouteSeed,
} from './agent-todo-route-fixture.js'

const dbTest = process.env.DATABASE_URL ? test : test.skip

const responseData = <T>(response: LightMyRequestResponse): T =>
  (response.json() as { data: T }).data

const responseErrorCode = (response: LightMyRequestResponse): string | undefined =>
  (response.json() as { error?: { code?: string } }).error?.code

const withDatabase = async (
  run: (prisma: PrismaClient, seed: AgentTodoRouteSeed) => Promise<void>,
): Promise<void> => {
  const prisma = new PrismaClient()
  let seed: AgentTodoRouteSeed | undefined
  try {
    seed = await seedAgentTodoRoutes(prisma)
    await run(prisma, seed)
  } finally {
    if (seed) await cleanupAgentTodoRoutes(prisma, seed)
    await prisma.$disconnect()
  }
}

const closeApps = async (...apps: FastifyInstance[]): Promise<void> => {
  await Promise.all(apps.map((app) => app.close()))
}

const createActiveTemplate = async (
  app: FastifyInstance,
  agentId: string,
  payload: object = activeTemplatePayload,
): Promise<AgentTodoTemplateRecord> => {
  const response = await app.inject({
    method: 'POST',
    payload,
    url: `/api/agents/${agentId}/todo-templates`,
  })
  assert.equal(response.statusCode, 201)
  return responseData<AgentTodoTemplateRecord>(response)
}

dbTest('template instantiation pins and copies the edited version without mutating old instances', async () => {
  await withDatabase(async (prisma, seed) => {
    const ownerApp = createAgentTodoRouteApp(prisma, seed, 'owner')
    const memberApp = createAgentTodoRouteApp(prisma, seed, 'member')
    try {
      const template = await createActiveTemplate(ownerApp, seed.agentId, {
        name: 'Pinned checklist',
        status: 'active',
        steps: [
          {
            instructions: 'Keep this exact instruction.',
            key: 'durable-first-key',
            title: 'Stable first step',
          },
          {
            instructions: 'Original second instruction.',
            key: 'durable-second-key',
            title: 'Second step',
          },
        ],
      })
      const created = await memberApp.inject({
        method: 'POST',
        payload: { templateId: template.id },
        url: `/api/agents/${seed.agentId}/todos`,
      })
      assert.equal(created.statusCode, 201)
      const original = responseData<AgentTodoRecord>(created)

      const editedResponse = await ownerApp.inject({
        method: 'PUT',
        payload: {
          name: 'Pinned checklist v2',
          steps: [
            {
              instructions: 'Keep this exact instruction.',
              title: 'Stable first step',
            },
            {
              instructions: 'Revised second instruction.',
              key: 'durable-second-key',
              title: 'Second step',
            },
          ],
          version: template.version,
        },
        url: `/api/agents/${seed.agentId}/todo-templates/${template.id}`,
      })
      assert.equal(editedResponse.statusCode, 200)
      const edited = responseData<AgentTodoTemplateRecord>(editedResponse)
      assert.equal(edited.version, template.version + 1)
      assert.equal(edited.authorType, 'user')
      assert.equal(edited.createdByUserId, seed.ownerId)
      assert.equal(edited.steps[0]?.key, 'durable-first-key')

      const currentResponse = await memberApp.inject({
        method: 'GET',
        url: `/api/agents/${seed.agentId}/todos/${original.id}`,
      })
      assert.equal(currentResponse.statusCode, 200)
      const current = responseData<AgentTodoRecord>(currentResponse)
      assert.equal(current.templateVersion, template.version)
      assert.deepEqual(
        current.steps.map(({ instructions, key, sequence, title }) => ({
          instructions,
          key,
          sequence,
          title,
        })),
        original.steps.map(({ instructions, key, sequence, title }) => ({
          instructions,
          key,
          sequence,
          title,
        })),
      )
      assert.equal(current.steps[1]?.instructions, 'Original second instruction.')
    } finally {
      await closeApps(ownerApp, memberApp)
    }
  })
})

dbTest('an instance refuses a template belonging to another agent', async () => {
  await withDatabase(async (prisma, seed) => {
    const ownerApp = createAgentTodoRouteApp(prisma, seed, 'owner')
    const memberApp = createAgentTodoRouteApp(prisma, seed, 'member')
    try {
      const foreignTemplate = await createActiveTemplate(ownerApp, seed.otherAgentId)
      const response = await memberApp.inject({
        method: 'POST',
        payload: { templateId: foreignTemplate.id },
        url: `/api/agents/${seed.agentId}/todos`,
      })

      assert.equal(response.statusCode, 409)
      assert.equal(
        responseErrorCode(response),
        AGENT_TODO_ERROR_CODES.TEMPLATE_UNAVAILABLE,
      )
      assert.equal(
        await prisma.agentTodo.count({
          where: { agentId: seed.agentId, templateId: foreignTemplate.id },
        }),
        0,
      )
    } finally {
      await closeApps(ownerApp, memberApp)
    }
  })
})

dbTest('an instance refuses a draft template belonging to the same agent', async () => {
  await withDatabase(async (prisma, seed) => {
    const ownerApp = createAgentTodoRouteApp(prisma, seed, 'owner')
    const memberApp = createAgentTodoRouteApp(prisma, seed, 'member')
    try {
      const draftTemplate = await createActiveTemplate(ownerApp, seed.agentId, {
        ...activeTemplatePayload,
        status: 'draft',
      })
      const response = await memberApp.inject({
        method: 'POST',
        payload: { templateId: draftTemplate.id },
        url: `/api/agents/${seed.agentId}/todos`,
      })

      assert.equal(response.statusCode, 409)
      assert.equal(
        responseErrorCode(response),
        AGENT_TODO_ERROR_CODES.TEMPLATE_UNAVAILABLE,
      )
    } finally {
      await closeApps(ownerApp, memberApp)
    }
  })
})

dbTest('a step update refuses a note beyond the shared maximum', async () => {
  await withDatabase(async (prisma, seed) => {
    const app = createAgentTodoRouteApp(prisma, seed, 'member')
    try {
      const created = await app.inject({
        method: 'POST',
        payload: {
          steps: [{ instructions: 'Keep working.', key: 'work', title: 'Work' }],
          title: 'Bounded note checklist',
        },
        url: `/api/agents/${seed.agentId}/todos`,
      })
      assert.equal(created.statusCode, 201)
      const todo = responseData<AgentTodoRecord>(created)

      const response = await app.inject({
        method: 'POST',
        payload: {
          note: 'x'.repeat(AGENT_TODO_STEP_NOTE_MAX + 1),
          status: 'completed',
        },
        url: `/api/agents/${seed.agentId}/todos/${todo.id}/steps/work`,
      })

      assert.equal(response.statusCode, 400)
    } finally {
      await app.close()
    }
  })
})

dbTest('the last terminal step completes a todo even when another step failed', async () => {
  await withDatabase(async (prisma, seed) => {
    const app = createAgentTodoRouteApp(prisma, seed, 'member')
    try {
      const created = await app.inject({
        method: 'POST',
        payload: {
          steps: [
            { key: 'attempt', title: 'Attempt', instructions: 'Try the action.' },
            { key: 'report', title: 'Report', instructions: 'Report the result.' },
          ],
          title: 'Failure-visible checklist',
        },
        url: `/api/agents/${seed.agentId}/todos`,
      })
      const todo = responseData<AgentTodoRecord>(created)

      const failed = await app.inject({
        method: 'POST',
        payload: { note: 'The action failed.', status: 'failed' },
        url: `/api/agents/${seed.agentId}/todos/${todo.id}/steps/attempt`,
      })
      assert.equal(failed.statusCode, 200)
      assert.equal(responseData<AgentTodoRecord>(failed).status, 'open')
      assert.equal(
        responseData<AgentTodoRecord>(failed).steps.find((step) => step.key === 'attempt')?.note,
        'The action failed.',
      )

      const completed = await app.inject({
        method: 'POST',
        payload: { status: 'completed' },
        url: `/api/agents/${seed.agentId}/todos/${todo.id}/steps/report`,
      })
      assert.equal(completed.statusCode, 200)
      const current = responseData<AgentTodoRecord>(completed)
      assert.equal(current.status, 'completed')
      assert.ok(current.completedAt)
      assert.equal(current.steps.find((step) => step.key === 'attempt')?.status, 'failed')
    } finally {
      await app.close()
    }
  })
})

dbTest('agent writes cannot overwrite a human terminal step but a human can correct it', async () => {
  await withDatabase(async (prisma, seed) => {
    const app = createAgentTodoRouteApp(prisma, seed, 'member')
    try {
      const created = await app.inject({
        method: 'POST',
        payload: {
          steps: [{ key: 'sign-off', title: 'Sign off', instructions: 'Confirm it.' }],
          title: 'Human sign-off checklist',
        },
        url: `/api/agents/${seed.agentId}/todos`,
      })
      const todo = responseData<AgentTodoRecord>(created)
      const humanTerminal = await app.inject({
        method: 'POST',
        payload: { status: 'completed' },
        url: `/api/agents/${seed.agentId}/todos/${todo.id}/steps/sign-off`,
      })
      assert.equal(humanTerminal.statusCode, 200)

      await assert.rejects(
        () => updateAgentTodoStep(prisma, {
          actor: { id: seed.agentId, type: 'agent' },
          agentId: seed.agentId,
          key: 'sign-off',
          organizationId: seed.organizationId,
          status: 'running',
          todoId: todo.id,
        }),
        (error: unknown) =>
          error instanceof AgentTodoError
          && error.code === AGENT_TODO_ERROR_CODES.HUMAN_TERMINAL_STATUS
          && error.message.includes('person'),
      )

      const corrected = await app.inject({
        method: 'POST',
        payload: { note: 'Correction by the person.', status: 'skipped' },
        url: `/api/agents/${seed.agentId}/todos/${todo.id}/steps/sign-off`,
      })
      assert.equal(corrected.statusCode, 200)
      const current = responseData<AgentTodoRecord>(corrected)
      assert.equal(current.steps[0]?.status, 'skipped')
      assert.equal(current.steps[0]?.note, 'Correction by the person.')
      assert.equal(current.steps[0]?.updatedByActorId, seed.memberId)

      const byId = await updateAgentTodoStep(prisma, {
        actor: { id: seed.memberId, type: 'user' },
        agentId: seed.agentId,
        organizationId: seed.organizationId,
        status: 'completed',
        stepId: current.steps[0]?.id ?? assert.fail('missing step'),
        todoId: todo.id,
      })
      assert.equal(byId.steps[0]?.status, 'completed')
    } finally {
      await app.close()
    }
  })
})

dbTest('cancel moves open to cancelled without changing activeRunId or the run', async () => {
  await withDatabase(async (prisma, seed) => {
    const app = createAgentTodoRouteApp(prisma, seed, 'member')
    try {
      const run = await prisma.run.create({
        data: { agentId: seed.agentId, status: 'running', threadId: seed.threadId },
      })
      const created = await app.inject({
        method: 'POST',
        payload: {
          steps: [{ key: 'work', title: 'Work', instructions: 'Do the work.' }],
          title: 'Running checklist',
        },
        url: `/api/agents/${seed.agentId}/todos`,
      })
      const todo = responseData<AgentTodoRecord>(created)
      await prisma.agentTodo.update({
        data: { activeRunId: run.id },
        where: { id: todo.id },
      })

      const response = await app.inject({
        method: 'POST',
        payload: {},
        url: `/api/agents/${seed.agentId}/todos/${todo.id}/cancel`,
      })
      assert.equal(response.statusCode, 200)
      const cancelled = responseData<AgentTodoRecord>(response)
      assert.equal(cancelled.status, 'cancelled')
      assert.equal(cancelled.activeRunId, run.id)
      assert.equal(
        (await prisma.run.findUnique({ where: { id: run.id }, select: { status: true } }))?.status,
        'running',
      )

      const cancelledList = await app.inject({
        method: 'GET',
        url: `/api/agents/${seed.agentId}/todos?status=cancelled`,
      })
      const openList = await app.inject({
        method: 'GET',
        url: `/api/agents/${seed.agentId}/todos?status=open`,
      })
      assert.deepEqual(
        responseData<AgentTodoRecord[]>(cancelledList).map((item) => item.id),
        [todo.id],
      )
      assert.deepEqual(responseData<AgentTodoRecord[]>(openList), [])
    } finally {
      await app.close()
    }
  })
})

dbTest('Run now requires target membership and a binding, then creates an internal kickoff, Run, and Task', async () => {
  await withDatabase(async (prisma, seed) => {
    const memberApp = createAgentTodoRouteApp(prisma, seed, 'member')
    const outsiderApp = createAgentTodoRouteApp(prisma, seed, 'outsider')
    try {
      const created = await memberApp.inject({
        method: 'POST',
        payload: {
          steps: [{ instructions: 'Run this exact step.', key: 'run', title: 'Run' }],
          title: 'Run-now checklist',
        },
        url: `/api/agents/${seed.agentId}/todos`,
      })
      const todo = responseData<AgentTodoRecord>(created)

      const noMembership = await outsiderApp.inject({
        method: 'POST',
        payload: { channelId: seed.channelId },
        url: `/api/agents/${seed.agentId}/todos/${todo.id}/run`,
      })
      assert.equal(noMembership.statusCode, 404)

      const unbound = await memberApp.inject({
        method: 'POST',
        payload: { channelId: seed.unboundChannelId },
        url: `/api/agents/${seed.agentId}/todos/${todo.id}/run`,
      })
      assert.equal(unbound.statusCode, 409)
      assert.equal(responseErrorCode(unbound), 'AGENT_NOT_BOUND')

      const started = await memberApp.inject({
        method: 'POST',
        payload: { channelId: seed.channelId },
        url: `/api/agents/${seed.agentId}/todos/${todo.id}/run`,
      })
      assert.equal(started.statusCode, 202)
      const run = await prisma.run.findFirst({
        orderBy: { createdAt: 'desc' },
        where: { agentId: seed.agentId },
      })
      assert.ok(run)
      assert.equal(await prisma.task.count({ where: { runId: run.id } }), 1)
      const kickoff = await prisma.message.findUnique({ where: { id: run.triggerMessageId ?? '' } })
      assert.equal(kickoff?.role, 'system')
      assert.match(kickoff?.content ?? '', /Run this exact step\./)
      assert.deepEqual(kickoff?.metadata, { todoKickoff: { todoId: todo.id } })
    } finally {
      await closeApps(memberApp, outsiderApp)
    }
  })
})

dbTest('Run now refuses a to-do claimed by a live run', async () => {
  await withDatabase(async (prisma, seed) => {
    const app = createAgentTodoRouteApp(prisma, seed, 'member')
    try {
      const todo = await createStandaloneAgentTodo(prisma, {
        agentId: seed.agentId,
        createdByUserId: seed.memberId,
        organizationId: seed.organizationId,
        steps: [{ instructions: 'Already running.', key: 'run', title: 'Run' }],
        title: 'Claimed checklist',
      })
      const run = await prisma.run.create({
        data: { agentId: seed.agentId, status: 'running', threadId: seed.threadId },
      })
      await prisma.agentTodo.update({ where: { id: todo.id }, data: { activeRunId: run.id } })
      const response = await app.inject({
        method: 'POST',
        payload: { channelId: seed.channelId },
        url: `/api/agents/${seed.agentId}/todos/${todo.id}/run`,
      })
      assert.equal(response.statusCode, 409)
      assert.equal(responseErrorCode(response), AGENT_TODO_ERROR_CODES.TODO_UNAVAILABLE)
    } finally {
      await app.close()
    }
  })
})

dbTest('an API-side queued cancellation leaves a stale pointer harmless and reclaimable', async () => {
  await withDatabase(async (prisma, seed) => {
    const todo = await createStandaloneAgentTodo(prisma, {
      agentId: seed.agentId,
      createdByUserId: seed.memberId,
      organizationId: seed.organizationId,
      steps: [{ instructions: 'Claim me after cancellation.', key: 'claim', title: 'Claim' }],
      title: 'Cancelled-run checklist',
    })
    const run = await prisma.run.create({
      data: { agentId: seed.agentId, status: 'pending', threadId: seed.threadId },
    })
    await prisma.agentTodo.update({ where: { id: todo.id }, data: { activeRunId: run.id } })
    await prisma.task.create({
      data: {
        agentId: seed.agentId,
        organizationId: seed.organizationId,
        purpose: 'cancelled test',
        runId: run.id,
      },
    })
    const result = await requestRunCancellation(prisma, {
      cancelledByUserId: seed.memberId,
      organizationId: seed.organizationId,
      runId: run.id,
    })
    assert.equal(result.kind, 'cancelled')
    const read = await getAgentTodo(prisma, {
      agentId: seed.agentId,
      organizationId: seed.organizationId,
      todoId: todo.id,
    })
    assert.equal(read?.activeRunId, null)
    const claimed = await claimAgentTodoForRun(prisma, {
      agentId: seed.agentId,
      organizationId: seed.organizationId,
      runId: (await prisma.run.create({
        data: { agentId: seed.agentId, status: 'running', threadId: seed.threadId },
      })).id,
      threadId: seed.threadId,
      todoId: todo.id,
    })
    assert.equal(claimed.activeRunId === run.id, false)
    assert.equal(claimed.status, 'running')
  })
})

dbTest('an approved template proposal activates only the reviewed draft version', async () => {
  await withDatabase(async (prisma, seed) => {
    const template = await createAgentTodoTemplate(prisma, {
      agentId: seed.agentId,
      authorType: 'agent',
      createdByUserId: null,
      name: 'Proposed template',
      organizationId: seed.organizationId,
      proposedByRunId: null,
      status: 'draft',
      steps: [{ instructions: 'Review the result.', title: 'Review' }],
    })
    const approval = await prisma.approvalRequest.create({
      data: {
        action: 'agent.todo_template.publish',
        agentId: seed.agentId,
        context: { templateId: template.id, version: template.version },
        continuationToken: randomUUID(),
        expiresAt: new Date(Date.now() + 86_400_000),
        organizationId: seed.organizationId,
        reason: 'Proposed template',
        requesterId: seed.agentId,
        requiredApproverRole: 'owner',
        status: 'pending',
      },
    })
    const published = await runApprovalEffect(prisma, approval, actorContextFor(seed, 'owner'))
    assert.equal(published.note, 'published')
    assert.equal(
      (await prisma.agentTodoTemplate.findUnique({ where: { id: template.id } }))?.status,
      'active',
    )

    const stale = await createAgentTodoTemplate(prisma, {
      agentId: seed.agentId,
      authorType: 'agent',
      createdByUserId: null,
      name: 'Edited before review',
      organizationId: seed.organizationId,
      proposedByRunId: null,
      status: 'draft',
      steps: [{ instructions: 'Original.', title: 'Original' }],
    })
    await prisma.agentTodoTemplate.update({
      where: { id: stale.id },
      data: { version: { increment: 1 } },
    })
    const staleResult = await runApprovalEffect(prisma, {
      action: 'agent.todo_template.publish',
      context: { templateId: stale.id, version: stale.version },
      id: randomUUID(),
    }, actorContextFor(seed, 'owner'))
    assert.match(staleResult.note ?? '', /superseded/)
    assert.equal(
      (await prisma.agentTodoTemplate.findUnique({ where: { id: stale.id } }))?.status,
      'draft',
    )
  })
})

dbTest('template activation is a version-pinned draft compare-and-set', async () => {
  await withDatabase(async (prisma, seed) => {
    const app = createAgentTodoRouteApp(prisma, seed, 'owner')
    try {
      const draftResponse = await app.inject({
        method: 'POST',
        payload: { ...activeTemplatePayload, status: 'draft' },
        url: `/api/agents/${seed.agentId}/todo-templates`,
      })
      const draft = responseData<AgentTodoTemplateRecord>(draftResponse)
      const stale = await activateAgentTodoTemplate(prisma, {
        agentId: seed.agentId,
        organizationId: seed.organizationId,
        templateId: draft.id,
        version: draft.version + 1,
      })
      assert.equal(stale, null)
      assert.equal(
        (await prisma.agentTodoTemplate.findUnique({ where: { id: draft.id } }))?.status,
        'draft',
      )

      const active = await activateAgentTodoTemplate(prisma, {
        agentId: seed.agentId,
        organizationId: seed.organizationId,
        templateId: draft.id,
        version: draft.version,
      })
      assert.equal(active?.status, 'active')

      const proposalRun = await prisma.run.create({
        data: { agentId: seed.agentId, status: 'completed', threadId: seed.threadId },
      })
      const proposed = await createAgentTodoTemplate(prisma, {
        agentId: seed.agentId,
        authorType: 'agent',
        createdByUserId: null,
        name: 'Agent-proposed checklist',
        organizationId: seed.organizationId,
        proposedByRunId: proposalRun.id,
        status: 'draft',
        steps: [{ instructions: 'Propose this.', key: 'proposal', title: 'Proposal' }],
      })
      assert.equal(proposed.authorType, 'agent')
      assert.equal(proposed.createdByUserId, null)
      assert.equal(proposed.proposedByRunId, proposalRun.id)
      assert.equal(proposed.status, 'draft')
    } finally {
      await app.close()
    }
  })
})

dbTest('concurrent final step writes serialize and derive completion', async () => {
  await withDatabase(async (prisma, seed) => {
    for (let iteration = 0; iteration < 8; iteration += 1) {
      const todo = await createStandaloneAgentTodo(prisma, {
        agentId: seed.agentId,
        createdByUserId: seed.memberId,
        organizationId: seed.organizationId,
        steps: [
          { key: 'left', title: 'Left', instructions: 'Finish left.' },
          { key: 'right', title: 'Right', instructions: 'Finish right.' },
        ],
        title: `Concurrent checklist ${iteration}`,
      })
      await Promise.all([
        updateAgentTodoStep(prisma, {
          actor: { id: seed.memberId, type: 'user' },
          agentId: seed.agentId,
          key: 'left',
          organizationId: seed.organizationId,
          status: 'completed',
          todoId: todo.id,
        }),
        updateAgentTodoStep(prisma, {
          actor: { id: seed.memberId, type: 'user' },
          agentId: seed.agentId,
          key: 'right',
          organizationId: seed.organizationId,
          status: 'completed',
          todoId: todo.id,
        }),
      ])
      const current = await getAgentTodo(prisma, {
        agentId: seed.agentId,
        organizationId: seed.organizationId,
        todoId: todo.id,
      })
      assert.equal(current?.status, 'completed', `iteration ${iteration}`)
    }
  })
})
