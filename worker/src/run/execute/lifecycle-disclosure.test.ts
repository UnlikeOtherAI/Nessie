import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { PrismaClient } from '@prisma/client'
import type { RunExecuteJobPayload } from '@nessie/schemas'
import { loadRunContext } from './lifecycle.js'

test('loadRunContext resolves bindings and the active demonstration once', async () => {
  const bindingQueries: unknown[] = []
  const demonstrationQueries: unknown[] = []
  const prisma = {
    agentBinding: {
      findMany: async (args: unknown) => {
        bindingQueries.push(args)
        return [{ agentId: 'agent-1' }, { agentId: 'agent-2' }]
      },
    },
    demonstration: {
      findFirst: async (args: unknown) => {
        demonstrationQueries.push(args)
        return { id: 'demonstration-1' }
      },
    },
    run: {
      findUnique: async () => ({
        agent: {
          agentKind: 'shared',
          effort: 'medium',
          executionMode: 'inference',
          id: 'agent-1',
          model: null,
          name: 'Writer',
          parentAgentId: null,
          provider: null,
          runLimits: null,
          systemPrompt: null,
        },
        createdAt: new Date('2026-08-31T00:00:00.000Z'),
        id: 'run-1',
        replyPlacement: null,
        tasks: [{ id: 'task-1' }],
        thread: {
          channel: {
            id: 'channel-1',
            organizationId: 'org-1',
            projectId: 'project-1',
            systemChannelType: null,
            teamId: 'team-1',
          },
          id: 'thread-1',
        },
      }),
    },
  } as unknown as PrismaClient

  const context = await loadRunContext(
    prisma,
    { runId: 'run-1', taskId: 'task-1' } as RunExecuteJobPayload,
  )

  assert.deepEqual(context?.boundAgentIds, ['agent-1', 'agent-2'])
  assert.equal(context?.activeDemonstrationId, 'demonstration-1')
  assert.deepEqual(bindingQueries, [{
    select: { agentId: true },
    where: { channelId: 'channel-1' },
  }])
  const [demonstrationQuery] = demonstrationQueries as [{
    select: unknown
    where: {
      agentId: string
      expiresAt: { gt: unknown }
      organizationId: string
      status: string
      threadId: string
    }
  }]
  assert.deepEqual({
    ...demonstrationQuery,
    where: {
      ...demonstrationQuery.where,
      expiresAt: { gt: demonstrationQuery.where.expiresAt.gt instanceof Date },
    },
  }, {
    select: { id: true },
    where: {
      agentId: 'agent-1',
      expiresAt: { gt: true },
      organizationId: 'org-1',
      status: 'recording',
      threadId: 'thread-1',
    },
  })
})
