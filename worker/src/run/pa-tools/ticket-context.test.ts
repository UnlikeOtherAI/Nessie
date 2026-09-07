import assert from 'node:assert/strict'
import test from 'node:test'
import { parseOrganizationId, parseUserId } from '@nessie/schemas'

import type { BuiltinToolRuntimeContext } from '../tool-types.js'
import { createConsumedSourceSink } from '../execute/disclosure-basis.js'
import { assertProjectChecklistDestination } from './ticket-checklists.js'
import { projectFor } from './ticket-context.js'

const member = {
  actorContext: {
    actionContext: { requestId: 'ticket-context-test' },
    actor: { actorId: parseUserId('22222222-2222-4222-8222-222222222222'), actorType: 'user' as const, roles: ['member'] },
    tenant: { organizationId: parseOrganizationId('11111111-1111-4111-8111-111111111111') },
  },
  isOwner: false,
  organizationId: parseOrganizationId('11111111-1111-4111-8111-111111111111'),
  role: 'member',
  userId: parseUserId('22222222-2222-4222-8222-222222222222'),
}

const contextWithBinding = (binding: number): BuiltinToolRuntimeContext => ({
  agentId: '33333333-3333-4333-8333-333333333333',
  agentKind: 'shared',
  actorContext: member.actorContext,
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

const checklistContext = (visibleAgents: Set<string>) => {
  const consumedSources = createConsumedSourceSink()
  return {
    consumedSources,
    context: {
      ...contextWithBinding(1),
      consumedSources,
      prisma: {
        agent: { count: async ({ where }: { where: { id: string } }) => Number(visibleAgents.has(where.id)) },
        organizationMember: { findMany: async () => [{ role: 'member', userId: member.userId }] },
        projectMember: { findMany: async () => [{ userId: member.userId }] },
      },
    } as unknown as BuiltinToolRuntimeContext,
  }
}

test('checklist writes permit a source every project reader can see and reject a private one', async () => {
  const shared = checklistContext(new Set(['public-agent']))
  shared.consumedSources.add({ scopeId: 'public-agent', scopeType: 'agent' })
  await assertProjectChecklistDestination(shared.context, {
    organizationId: member.organizationId,
    projectId: '55555555-5555-4555-8555-555555555555',
  })

  const privateSource = checklistContext(new Set())
  privateSource.consumedSources.add({ scopeId: 'private-agent', scopeType: 'agent' })
  await assert.rejects(
    assertProjectChecklistDestination(privateSource.context, {
      organizationId: member.organizationId,
      projectId: '55555555-5555-4555-8555-555555555555',
    }),
    /restricted research/,
  )
})
