import assert from 'node:assert/strict'
import test from 'node:test'

import type { Prisma, PrismaClient } from '@prisma/client'

import { runSpawnSubtaskTool } from '../src/run/subtask-tools.js'
import { isPersonalAssistantPresenceRun, resolveAgentTools } from '../src/run/tool-policy.js'
import type { BuiltinToolRuntimeContext } from '../src/run/tool-types.js'

const ORGANIZATION_ID = '30000000-0000-4000-8000-000000000001'
const CHANNEL_ID = '30000000-0000-4000-8000-000000000002'
const THREAD_ID = '30000000-0000-4000-8000-000000000003'
const PARENT_AGENT_ID = '30000000-0000-4000-8000-000000000004'
const CHILD_AGENT_ID = '30000000-0000-4000-8000-000000000005'
const PARENT_RUN_ID = '30000000-0000-4000-8000-000000000006'
const CHILD_RUN_ID = '30000000-0000-4000-8000-000000000007'
const MESSAGE_ID = '30000000-0000-4000-8000-000000000008'
const TASK_ID = '30000000-0000-4000-8000-000000000009'
const OWNER_USER_ID = '30000000-0000-4000-8000-00000000000a'

test('spawn_subtask inherits private visibility from its parent', async () => {
  let childData: Prisma.AgentCreateInput | null = null
  let childRunData: { principalUserId?: string | null } | null = null
  const tx = {
    $executeRaw: async () => 1,
    agent: {
      create: async ({ data }: { data: Prisma.AgentCreateInput }) => {
        childData = data
        return { id: CHILD_AGENT_ID, name: 'Private parent researcher' }
      },
    },
    run: {
      create: async ({ data }: { data: { principalUserId?: string | null } }) => {
        childRunData = data
        return { id: CHILD_RUN_ID, threadId: THREAD_ID }
      },
    },
    task: {
      create: async () => ({ id: TASK_ID }),
    },
  }
  const prisma = {
    $transaction: async <T>(action: (client: typeof tx) => Promise<T>) => action(tx),
    agent: {
      findUnique: async () => ({
        effort: 'medium',
        id: PARENT_AGENT_ID,
        model: 'gpt-5',
        name: 'Private parent',
        ownerUserId: OWNER_USER_ID,
        provider: 'openai',
        systemPrompt: null,
        toolPolicy: null,
        visibility: 'private',
      }),
    },
    plan: { findFirst: async () => null },
  } as unknown as PrismaClient
  const context = {
    agentId: PARENT_AGENT_ID,
    agentKind: 'shared',
    actorContext: {
      actionContext: { requestId: 'subtask-visibility' },
      actor: { actorId: OWNER_USER_ID, actorType: 'user', roles: ['member'] },
      tenant: { organizationId: ORGANIZATION_ID },
    },
    channel: { id: CHANNEL_ID, organizationId: ORGANIZATION_ID },
    ledgerIdentity: null,
    prisma,
    realtimeTransport: { publishWs: async () => undefined },
    run: {
      id: PARENT_RUN_ID,
      messageId: MESSAGE_ID,
      principalUserId: OWNER_USER_ID,
      threadId: THREAD_ID,
    },
    toolCallId: null,
  } as unknown as BuiltinToolRuntimeContext

  await runSpawnSubtaskTool(context, { role: 'researcher', task: 'Investigate privately' })

  assert.ok(childData)
  assert.equal(childData.visibility, 'private')
  assert.equal(childData.ownerUserId, OWNER_USER_ID)
  assert.equal(childData.parentAgentId, PARENT_AGENT_ID)
  assert.deepEqual(childRunData, {
    agentId: CHILD_AGENT_ID,
    principalUserId: OWNER_USER_ID,
    status: 'pending',
    threadId: THREAD_ID,
  })
})

test('a shared child carrying a PA-presence principal keeps the reduced toolset', () => {
  const isPresence = isPersonalAssistantPresenceRun({
    agentKind: 'shared',
    principalUserId: OWNER_USER_ID,
    systemChannelType: null,
  })
  assert.equal(isPresence, true)

  const resolved = resolveAgentTools(
    new Set(['kb_search', 'spawn_subtask']),
    [
      { description: 'Search', id: 'kb_search', parameters: {} },
      { description: 'Delegate', id: 'spawn_subtask', parameters: {} },
    ],
    null,
    PARENT_AGENT_ID,
    'shared',
    { isPersonalAssistantPresence: isPresence },
  )
  assert.equal(resolved.allowedIds.has('kb_search'), false)
})
