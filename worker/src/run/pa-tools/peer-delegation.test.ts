import assert from 'node:assert/strict'
import test from 'node:test'
import { parseOrganizationId, parseUserId } from '@nessie/schemas'

import { runAgentPeerDelegateTool } from './peer-delegation.js'
import type { BuiltinToolRuntimeContext } from '../tool-types.js'

const ID = '00000000-0000-4000-8000-000000000001'
const PEER = '00000000-0000-4000-8000-000000000002'
const PROJECT = '00000000-0000-4000-8000-000000000003'
const CHANNEL = '00000000-0000-4000-8000-000000000004'

const context = (overrides: Partial<BuiltinToolRuntimeContext> = {}): BuiltinToolRuntimeContext => ({
  agentId: '00000000-0000-4000-8000-000000000005', agentKind: 'shared',
  actorContext: { actor: { actorId: parseUserId(ID), actorType: 'user' }, actionContext: { requestId: 'test' }, tenant: { organizationId: parseOrganizationId('00000000-0000-4000-8000-000000000006') } },
  channel: { id: CHANNEL, organizationId: parseOrganizationId('00000000-0000-4000-8000-000000000006'), projectId: PROJECT },
  consumedSources: {
    add: () => undefined,
    addAll: () => undefined,
    addPrivateConversationSource: () => undefined,
    list: () => [],
    privateConversationSources: () => [],
    size: () => 0,
  },
  ledgerIdentity: null, prisma: {} as BuiltinToolRuntimeContext['prisma'], realtimeTransport: {} as BuiltinToolRuntimeContext['realtimeTransport'],
  run: { id: '00000000-0000-4000-8000-000000000007', interactive: true, messageId: ID, threadId: '00000000-0000-4000-8000-000000000008' }, toolCallId: 'call-1',
  ...overrides,
})

test('peer delegation rejects a forged effective user before any database access', async () => {
  const forged = context({
    actorContext: {
      actor: { actorId: parseUserId(ID), actorType: 'user' },
      actionContext: { effectiveUserId: parseUserId(PEER), requestId: 'test' },
      tenant: { organizationId: parseOrganizationId('00000000-0000-4000-8000-000000000006') },
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

test('peer delegation preserves known and unknown private-source authors for the target run', async () => {
  const basis = [{ scopeId: PEER, scopeType: 'agent' }]
  const disclosureSources = [
    { sourceAuthorUserId: ID, sourceChannelId: CHANNEL },
    { sourceAuthorUserId: null, sourceChannelId: CHANNEL },
  ]
  let storedBasis: unknown = null
  let storedSources: unknown = null
  let storedUoaIdentity: unknown = null
  const restricted = context({
    actorContext: {
      actor: { actorId: parseUserId(ID), actorType: 'user' },
      actionContext: {
        requestId: 'test',
        uoaIdentity: {
          organizationId: 'uoa-org', subject: 'uoa-subject', teamId: 'uoa-team', tokenVersion: 7,
        },
      },
      tenant: { organizationId: parseOrganizationId('00000000-0000-4000-8000-000000000006') },
    },
    consumedSources: {
      add: () => undefined,
      addAll: () => undefined,
      addPrivateConversationSource: () => undefined,
      list: () => basis,
      privateConversationSources: () => disclosureSources,
      size: () => 1,
    },
    prisma: {
      agent: { findFirst: async () => ({ id: PEER, name: 'Coordinator' }) },
      agentBinding: { count: async () => 1 },
      agentMailboxMessage: {
        create: async ({ data }: { data: {
          basis: unknown
          disclosureSources: unknown
          uoaIdentity?: unknown
        } }) => {
          storedBasis = data.basis
          storedSources = data.disclosureSources
          storedUoaIdentity = data.uoaIdentity
          return { id: ID }
        },
      },
      organizationMember: { findUnique: async () => ({ deactivatedAt: null, role: 'owner' }) },
      project: { count: async () => 1 },
    } as unknown as BuiltinToolRuntimeContext['prisma'],
  })
  await runAgentPeerDelegateTool(restricted, { agentId: PEER, brief: 'review' })
  assert.deepEqual(storedBasis, basis)
  assert.deepEqual(storedSources, disclosureSources)
  assert.deepEqual(storedUoaIdentity, {
    organizationId: 'uoa-org', subject: 'uoa-subject', teamId: 'uoa-team', tokenVersion: 7,
  })
})

test('peer delegation refuses an agent after its source binding is removed', async () => {
  const unbound = context({
    prisma: { agentBinding: { count: async () => 0 } } as unknown as BuiltinToolRuntimeContext['prisma'],
  })
  await assert.rejects(() => runAgentPeerDelegateTool(unbound, { agentId: PEER, brief: 'review' }), /no longer bound/)
})
