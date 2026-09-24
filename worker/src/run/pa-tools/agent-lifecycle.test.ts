import assert from 'node:assert/strict'
import test from 'node:test'

import type { BuiltinToolRuntimeContext } from '../tool-types.js'
import { runAgentDeleteTool, runAgentTriggerUpdateTool } from './agent-lifecycle.js'
import { runAgentUnbindChannelTool } from './agent-lifecycle.js'

test('trigger lifecycle rejects a demoted owner before mutation', async () => {
  let updates = 0
  // The Agent Designer's face: its own home DM, where the identity arm opens.
  const context = {
    agentId: '00000000-0000-4000-8000-000000000001',
    agentKind: 'shared',
    channel: { id: '00000000-0000-4000-8000-000000000002', organizationId: '00000000-0000-4000-8000-000000000003', systemChannelType: 'system_agent' },
    actorContext: { actor: { actorId: '00000000-0000-4000-8000-000000000004', actorType: 'user', roles: ['owner'] }, tenant: { organizationId: '00000000-0000-4000-8000-000000000003' }, actionContext: {} },
    prisma: { organizationMember: { findUnique: async () => ({ role: 'member', deactivatedAt: null }) }, agentTrigger: { update: async () => { updates += 1 } } },
  } as unknown as BuiltinToolRuntimeContext
  await assert.rejects(() => runAgentTriggerUpdateTool(context, { triggerId: '00000000-0000-4000-8000-000000000005', enabled: false }), /Only an organisation owner/)
  assert.equal(updates, 0)
})

test('unbind does not disclose or mutate a private channel the admin cannot reach', async () => {
  let deletes = 0
  const context = {
    agentId: '00000000-0000-4000-8000-000000000001', agentKind: 'shared',
    channel: { id: '00000000-0000-4000-8000-000000000002', organizationId: '00000000-0000-4000-8000-000000000003' },
    actorContext: { actor: { actorId: '00000000-0000-4000-8000-000000000004', actorType: 'user', roles: ['admin'] }, tenant: { organizationId: '00000000-0000-4000-8000-000000000003' }, actionContext: {} },
    prisma: { organizationMember: { findUnique: async () => ({ role: 'admin', deactivatedAt: null }) }, channel: { findUnique: async () => ({ id: '00000000-0000-4000-8000-000000000005', organizationId: '00000000-0000-4000-8000-000000000003', deletedAt: null, dmKey: 'private', systemChannelType: null, type: 'dm', members: [] }) }, agentBinding: { deleteMany: async () => { deletes += 1 } } },
  } as unknown as BuiltinToolRuntimeContext
  await assert.rejects(() => runAgentUnbindChannelTool(context, { agentId: '00000000-0000-4000-8000-000000000006', channelId: '00000000-0000-4000-8000-000000000005' }), /Channel not found/)
  assert.equal(deletes, 0)
})

test('a live organization admin can unbind a reachable standard channel', async () => {
  let deletes = 0
  const context = {
    agentId: '00000000-0000-4000-8000-000000000001', agentKind: 'shared',
    channel: { id: '00000000-0000-4000-8000-000000000002', organizationId: '00000000-0000-4000-8000-000000000003' },
    actorContext: { actor: { actorId: '00000000-0000-4000-8000-000000000004', actorType: 'user', roles: ['admin'] }, tenant: { organizationId: '00000000-0000-4000-8000-000000000003' }, actionContext: {} },
    prisma: {
      organizationMember: { findUnique: async () => ({ role: 'admin', deactivatedAt: null }) },
      channel: { findUnique: async () => ({ id: '00000000-0000-4000-8000-000000000005', organizationId: '00000000-0000-4000-8000-000000000003', deletedAt: null, dmKey: null, systemChannelType: null, type: 'standard', members: [{ id: 'member' }] }) },
      agent: { findFirst: async () => ({ id: '00000000-0000-4000-8000-000000000006' }) },
      agentBinding: { deleteMany: async () => { deletes += 1 } },
      $queryRaw: async () => [{ id: 'rule', scope: 'organization', scopeId: '00000000-0000-4000-8000-000000000003', resourceType: 'agent', action: 'bind', effect: 'allow', priority: 0, conditions: {}, actorType: 'user', actorId: '00000000-0000-4000-8000-000000000004' }],
      auditLog: { create: async () => ({}) },
    }, realtimeTransport: { publishWs: async () => undefined },
  } as unknown as BuiltinToolRuntimeContext
  const result = await runAgentUnbindChannelTool(context, { agentId: '00000000-0000-4000-8000-000000000006', channelId: '00000000-0000-4000-8000-000000000005' })
  assert.equal(result.toolName, 'agent_unbind_channel')
  assert.equal(deletes, 1)
})

test('delete refuses a Nessie-managed agent before revocation writes', async () => {
  const context = {
    agentId: '00000000-0000-4000-8000-000000000001', agentKind: 'shared', channel: { id: '00000000-0000-4000-8000-000000000002', organizationId: '00000000-0000-4000-8000-000000000003' },
    actorContext: { actor: { actorId: '00000000-0000-4000-8000-000000000004', actorType: 'user', roles: ['owner'] }, tenant: { organizationId: '00000000-0000-4000-8000-000000000003' }, actionContext: {} },
    prisma: { organizationMember: { findUnique: async () => ({ role: 'owner', deactivatedAt: null }) }, agent: { findFirst: async () => ({ id: '00000000-0000-4000-8000-000000000005', deletedAt: null, organizationId: '00000000-0000-4000-8000-000000000003', ownerUserId: null, systemManaged: true, visibility: 'team' }) } },
  } as unknown as BuiltinToolRuntimeContext
  await assert.rejects(() => runAgentDeleteTool(context, { agentId: '00000000-0000-4000-8000-000000000005' }), /managed by Nessie|cannot be edited/i)
})
