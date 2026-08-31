import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { PrismaClient } from '@prisma/client'
import type { RunExecuteJobPayload } from '@nessie/schemas'
import { loadRunContext } from './lifecycle.js'

test('loadRunContext resolves destination bindings once and caches their agent ids', async () => {
  const bindingQueries: unknown[] = []
  const prisma = {
    agentBinding: {
      findMany: async (args: unknown) => {
        bindingQueries.push(args)
        return [{ agentId: 'agent-1' }, { agentId: 'agent-2' }]
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
  assert.deepEqual(bindingQueries, [{
    select: { agentId: true },
    where: { channelId: 'channel-1' },
  }])
})
