import assert from 'node:assert/strict'
import test from 'node:test'

import type { BuiltinToolRuntimeContext } from '../tool-types.js'
import { runAgentCreateTool } from './provisioning.js'

const actingUserId = '4f7d1c00-0e64-4d10-a517-0d0b69c1d004'
const otherUserId = '4f7d1c00-0e64-4d10-a517-0d0b69c1d014'

test('agent_create refuses a private agent requested for another person', async () => {
  let createCalls = 0
  const context = {
    actorContext: {
      actionContext: { requestId: 'request-private-owner-refusal' },
      actor: { actorId: actingUserId, actorType: 'user', roles: ['member'] },
      tenant: { organizationId: 'org-1' },
    },
    agentId: 'assistant-1',
    agentKind: 'personal_assistant',
    channel: { id: 'channel-1', organizationId: 'org-1' },
    ledgerIdentity: null,
    prisma: {
      agent: { create: async () => { createCalls += 1 } },
      organizationMember: {
        findUnique: async () => ({ deactivatedAt: null, role: 'member' }),
      },
    },
    realtimeTransport: {},
    run: { id: 'run-1', messageId: 'message-1', threadId: 'thread-1' },
    toolCallId: 'call-1',
  } as unknown as BuiltinToolRuntimeContext

  await assert.rejects(
    () => runAgentCreateTool(context, {
      name: 'Someone else\'s private agent',
      ownerUserId: otherUserId,
      visibility: 'private',
    }),
    /A private agent can only be created for you/,
  )
  assert.equal(createCalls, 0)
})
