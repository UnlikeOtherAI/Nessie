import assert from 'node:assert/strict'
import test from 'node:test'

import type { BuiltinToolRuntimeContext } from '../tool-types.js'
import { projectFor } from './ticket-context.js'

const member = {
  actorContext: {
    actionContext: {},
    actor: { actorId: '22222222-2222-4222-8222-222222222222', actorType: 'user' as const, roles: ['member'] },
    tenant: { organizationId: '11111111-1111-4111-8111-111111111111' },
  },
  isOwner: false,
  organizationId: '11111111-1111-4111-8111-111111111111',
  role: 'member',
  userId: '22222222-2222-4222-8222-222222222222',
}

const contextWithBinding = (binding: number): BuiltinToolRuntimeContext => ({
  agentId: '33333333-3333-4333-8333-333333333333',
  agentKind: 'shared',
  channel: {
    id: '44444444-4444-4444-8444-444444444444',
    organizationId: member.organizationId,
    projectId: '55555555-5555-4555-8555-555555555555',
  },
  prisma: {
    agentBinding: { count: async () => binding },
    project: { count: async () => 1 },
    projectMember: { count: async () => 1 },
  },
} as unknown as BuiltinToolRuntimeContext)

test('a shared ticket agent rechecks its binding before every project operation', async () => {
  await assert.rejects(
    projectFor(contextWithBinding(0), member, '55555555-5555-4555-8555-555555555555'),
    /no longer bound/,
  )
  await projectFor(contextWithBinding(1), member, '55555555-5555-4555-8555-555555555555')
})
