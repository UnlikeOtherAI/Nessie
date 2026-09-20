import assert from 'node:assert/strict'
import test from 'node:test'

import type { BuiltinToolRuntimeContext } from '../tool-types.js'
import { runAgentTriggerUpdateTool } from './agent-lifecycle.js'
import { runAgentUnbindChannelTool } from './agent-lifecycle.js'

test('trigger lifecycle rejects a demoted owner before mutation', async () => {
  let updates = 0
  const context = {
    agentId: '00000000-0000-4000-8000-000000000001',
    agentKind: 'shared',
    channel: { id: '00000000-0000-4000-8000-000000000002', organizationId: '00000000-0000-4000-8000-000000000003' },
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
