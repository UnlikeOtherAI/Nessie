import assert from 'node:assert/strict'
import test from 'node:test'

import type { BuiltinToolRuntimeContext } from './tool-types.js'
import { runSpawnSubtaskTool } from './subtask-tools.js'

const organizationId = '00000000-0000-4000-8000-000000000001'
const agentId = '00000000-0000-4000-8000-000000000002'
const channelId = '00000000-0000-4000-8000-000000000003'
const threadId = '00000000-0000-4000-8000-000000000004'
const messageId = '00000000-0000-4000-8000-000000000005'
const parentRunId = '00000000-0000-4000-8000-000000000006'
const childAgentId = '00000000-0000-4000-8000-000000000007'
const childRunId = '00000000-0000-4000-8000-000000000008'
const childTaskId = '00000000-0000-4000-8000-000000000009'
const projectedId = '00000000-0000-4000-8000-000000000010'
const teamId = '00000000-0000-4000-8000-000000000011'

test('spawned child strips every explicit grant while preserving ordinary policy', async () => {
  let createdToolPolicy: unknown
  const parentToolPolicy = {
    ordinary_allow: true,
    ordinary_deny: false,
    deep_water_run_update: true,
    [projectedId]: true,
    [`__nessie_deep_water_bundle__:${teamId}`]: true,
    __nessie_deep_water_manual_updater__: true,
  }
  const tx = {
    $executeRaw: async () => 1,
    agent: {
      create: async ({ data }: { data: { toolPolicy?: unknown } }) => {
        createdToolPolicy = data.toolPolicy
        return { id: childAgentId, name: 'Child' }
      },
    },
    run: {
      create: async () => ({ id: childRunId, threadId }),
    },
    task: {
      create: async () => ({ id: childTaskId }),
    },
  }
  const prisma = {
    $transaction: async <T>(action: (client: typeof tx) => Promise<T>) =>
      action(tx),
    agent: {
      findUnique: async () => ({
        id: agentId,
        model: 'model',
        name: 'Parent',
        provider: 'provider',
        systemPrompt: 'Prompt',
        toolPolicy: parentToolPolicy,
      }),
    },
    plan: {
      findFirst: async () => null,
    },
    toolRegistryEntry: {
      findMany: async () => [{
        id: projectedId,
        metadata: { requiresExplicitGrant: true },
        toolId: 'mcp:deep-water:research_start',
      }],
    },
  }
  const context = {
    actorContext: {
      actionContext: { requestId: 'subtask-policy' },
      actor: { actorId: agentId, actorType: 'agent', roles: [] },
      tenant: { organizationId },
    },
    agentId,
    agentKind: 'shared',
    channel: { id: channelId, organizationId },
    prisma,
    realtimeTransport: { publishWs: async () => undefined },
    run: { id: parentRunId, messageId, threadId },
  } as unknown as BuiltinToolRuntimeContext

  await runSpawnSubtaskTool(context, {
    role: 'researcher',
    task: 'Investigate safely',
  })

  assert.deepEqual(createdToolPolicy, {
    ordinary_allow: true,
    ordinary_deny: false,
  })
})
