import assert from 'node:assert/strict'
import { test } from 'node:test'

import { buildVisibleAgentWhere } from '@nessie/db'
import {
  resolveDisclosureViewer,
  type DisclosureAccessPrisma,
} from '../src/disclosure-access.js'
import { viewerSatisfiesBasis } from '../src/disclosure-predicate.js'

const buildPrisma = (
  visibleAgentIds: readonly string[],
  options: { liveMembership?: boolean } = {},
) => {
  const agentQueries: unknown[] = []
  const prisma = {
    agent: {
      findMany: async (args: unknown) => {
        agentQueries.push(args)
        return visibleAgentIds.map((id) => ({ id }))
      },
    },
    channelMember: {
      findMany: async () => [{ channelId: 'channel-1' }],
    },
    organizationMember: {
      findFirst: async () => options.liveMembership === false ? null : { id: 'membership-1' },
    },
    projectMember: {
      findMany: async () => [{ projectId: 'project-1' }],
    },
    teamMember: {
      findMany: async () => [{ teamId: 'team-1' }],
    },
  } as unknown as DisclosureAccessPrisma
  return { agentQueries, prisma }
}

test('resolved viewers carry agent scopes for exactly the agents they can see', async () => {
  const { agentQueries, prisma } = buildPrisma(['agent-1', 'agent-2'])

  const viewer = await resolveDisclosureViewer(prisma, 'org-1', 'user-1')

  assert.equal(viewer.kind, 'user')
  assert.deepEqual(
    viewer.kind === 'user'
      ? viewer.scopes.filter((scope) => scope.scopeType === 'agent')
      : [],
    [
      { scopeId: 'agent-1', scopeType: 'agent' },
      { scopeId: 'agent-2', scopeType: 'agent' },
    ],
  )
  assert.deepEqual(agentQueries, [{
    select: { id: true },
    where: buildVisibleAgentWhere({ organizationId: 'org-1', userId: 'user-1' }),
  }])
})

test('an agent-scoped reply is visible only to a viewer who can see that agent', async () => {
  const basis = [{ scopeId: 'agent-1', scopeType: 'agent' }]
  const entitled = await resolveDisclosureViewer(buildPrisma(['agent-1']).prisma, 'org-1', 'user-1')
  const unentitled = await resolveDisclosureViewer(buildPrisma([]).prisma, 'org-1', 'user-2')

  assert.equal(viewerSatisfiesBasis(basis, entitled), true)
  assert.equal(viewerSatisfiesBasis(basis, unentitled), false)
})

test('missing or inactive users stay autonomous and never query agent visibility', async () => {
  const missing = buildPrisma(['agent-1'])
  const inactive = buildPrisma(['agent-1'], { liveMembership: false })

  const withoutUser = await resolveDisclosureViewer(missing.prisma, 'org-1', null)
  const withoutMembership = await resolveDisclosureViewer(inactive.prisma, 'org-1', 'user-1')

  assert.deepEqual(withoutUser, { kind: 'autonomous' })
  assert.deepEqual(withoutMembership, { kind: 'autonomous' })
  assert.equal(viewerSatisfiesBasis([{ scopeId: 'agent-1', scopeType: 'agent' }], withoutUser), false)
  assert.equal(missing.agentQueries.length, 0)
  assert.equal(inactive.agentQueries.length, 0)
})
