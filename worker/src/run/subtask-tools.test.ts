import assert from 'node:assert/strict'
import test from 'node:test'

import { createConsumedSourceSink } from './execute/disclosure-basis.js'
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
const taskPromptId = '00000000-0000-4000-8000-000000000012'

test('spawned child strips every explicit grant while preserving ordinary policy', async () => {
  let createdToolPolicy: unknown
  let taskPrompt: { content: string; role: string; threadId: string } | undefined
  let runTriggerMessageId: string | undefined
  let stampedBasis: unknown
  let stampedSources: unknown
  const consumedSources = createConsumedSourceSink()
  consumedSources.add({ scopeId: 'private-channel', scopeType: 'channel' })
  consumedSources.addPrivateConversationSource({
    sourceAuthorUserId: 'author-b',
    sourceChannelId: 'private-channel',
  })
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
    message: {
      create: async ({ data }: { data: { content: string; role: string; threadId: string } }) => {
        taskPrompt = data
        return { id: taskPromptId }
      },
    },
    messageBasisScope: {
      createMany: async ({ data }: { data: unknown }) => {
        stampedBasis = data
      },
    },
    messageDisclosureSource: {
      createMany: async ({ data }: { data: unknown }) => {
        stampedSources = data
      },
    },
    run: {
      create: async ({ data }: { data: { triggerMessageId?: string } }) => {
        runTriggerMessageId = data.triggerMessageId
        return { id: childRunId, threadId }
      },
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
    consumedSources,
    prisma,
    realtimeTransport: { publishWs: async () => undefined },
    run: { id: parentRunId, messageId, threadId },
  } as unknown as BuiltinToolRuntimeContext

  await runSpawnSubtaskTool(context, {
    role: 'researcher',
    task: 'Private B canary: investigate safely',
  })

  assert.deepEqual(createdToolPolicy, {
    ordinary_allow: true,
    ordinary_deny: false,
  })
  assert.deepEqual(taskPrompt, {
    content: 'Private B canary: investigate safely',
    role: 'system',
    threadId,
  })
  assert.equal(runTriggerMessageId, taskPromptId)
  assert.deepEqual(stampedBasis, [{
    messageId: taskPromptId,
    organizationId,
    scopeId: 'private-channel',
    scopeType: 'channel',
  }])
  assert.deepEqual(stampedSources, [{
    messageId: taskPromptId,
    organizationId,
    sourceAuthorUserId: 'author-b',
    sourceChannelId: 'private-channel',
  }])
})
