import assert from 'node:assert/strict'
import test from 'node:test'

import { runAgentPeerDelegateTool } from './peer-delegation.js'
import type { BuiltinToolRuntimeContext } from '../tool-types.js'

const ID = '00000000-0000-4000-8000-000000000001'
const PEER = '00000000-0000-4000-8000-000000000002'
const PROJECT = '00000000-0000-4000-8000-000000000003'
const CHANNEL = '00000000-0000-4000-8000-000000000004'

const context = (overrides: Partial<BuiltinToolRuntimeContext> = {}): BuiltinToolRuntimeContext => ({
  agentId: '00000000-0000-4000-8000-000000000005', agentKind: 'shared',
  actorContext: { actor: { actorId: ID, actorType: 'user' }, actionContext: { requestId: 'test' }, tenant: { organizationId: '00000000-0000-4000-8000-000000000006' } },
  channel: { id: CHANNEL, organizationId: '00000000-0000-4000-8000-000000000006', projectId: PROJECT },
  consumedSources: { add: () => undefined, addAll: () => undefined, list: () => [], size: () => 0 },
  ledgerIdentity: null, prisma: {} as BuiltinToolRuntimeContext['prisma'], realtimeTransport: {} as BuiltinToolRuntimeContext['realtimeTransport'],
  run: { id: '00000000-0000-4000-8000-000000000007', interactive: true, messageId: ID, threadId: '00000000-0000-4000-8000-000000000008' }, toolCallId: 'call-1',
  ...overrides,
})

test('peer delegation rejects a forged effective user before any database access', async () => {
  const forged = context({
    actorContext: {
      actor: { actorId: ID, actorType: 'user' },
      actionContext: { effectiveUserId: PEER, requestId: 'test' },
      tenant: { organizationId: '00000000-0000-4000-8000-000000000006' },
    },
  })
  await assert.rejects(
    () => runAgentPeerDelegateTool(forged, { agentId: PEER, brief: 'review' }),
    /identity does not match/,
  )
})

test('peer delegation refuses a fifth hop before it can write a mailbox item', async () => {
  const exhausted = context({
    run: { id: ID, interactive: true, messageId: ID, peerDelegationDepth: 4, threadId: PEER },
  })
  await assert.rejects(() => runAgentPeerDelegateTool(exhausted, { agentId: PEER, brief: 'review' }), /bounded peer-delegation limit/)
})

test('peer delegation refuses a run that consumed restricted material', async () => {
  const restricted = context({
    consumedSources: { add: () => undefined, addAll: () => undefined, list: () => [], size: () => 1 },
  })
  await assert.rejects(() => runAgentPeerDelegateTool(restricted, { agentId: PEER, brief: 'review' }), /restricted sources/)
})

test('peer delegation refuses an agent after its source binding is removed', async () => {
  const unbound = context({
    prisma: { agentBinding: { count: async () => 0 } } as unknown as BuiltinToolRuntimeContext['prisma'],
  })
  await assert.rejects(() => runAgentPeerDelegateTool(unbound, { agentId: PEER, brief: 'review' }), /no longer bound/)
})
