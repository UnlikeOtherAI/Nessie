import assert from 'node:assert/strict'
import { test } from 'node:test'

import { buildVisibleAgentWhere } from '@nessie/db'
import {
  resolveDisclosureViewer,
  resolveGrantedDisclosureScopeKeys,
  resolveGrantedScopeKeysForMessages,
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

/**
 * Both hot message reads used to resolve grants one withheld row at a time —
 * the channel page in series, the reply-panel read acknowledgement fanned out —
 * at two queries per row. The batched resolver answers a whole page in a fixed
 * two queries plus one resolution per *distinct granter*, so the cost stops
 * following the page size.
 */
const buildGrantPrisma = (input: {
  messageGrants?: Array<{ grantedByUserId: string; messageId: string }>
  scopeGrants?: Array<{
    agentId: string
    grantedByUserId: string
    sourceScopeId: string
    sourceScopeType: string
  }>
} = {}) => {
  const calls: string[] = []
  const prisma = {
    agent: { findMany: async () => [] },
    channelMember: { findMany: async () => { calls.push('channelMember'); return [{ channelId: 'channel-1' }] } },
    disclosureGrant: {
      findMany: async () => { calls.push('disclosureGrant'); return input.messageGrants ?? [] },
    },
    organizationMember: {
      findFirst: async () => { calls.push('organizationMember'); return { id: 'membership-1' } },
    },
    // Every granter here is a live member of the project the basis names, so a
    // grant they made genuinely lifts it.
    projectMember: {
      findMany: async () => { calls.push('projectMember'); return [{ projectId: 'project-1' }] },
    },
    scopeDisclosureGrant: {
      findMany: async () => { calls.push('scopeDisclosureGrant'); return input.scopeGrants ?? [] },
    },
    teamMember: { findMany: async () => { calls.push('teamMember'); return [] } },
  } as unknown as DisclosureAccessPrisma
  return { calls, prisma }
}

const withheldPage = (count: number) =>
  Array.from({ length: count }, (_unused, index) => ({
    agentId: `agent-${index}`,
    basis: [{ scopeId: 'project-1', scopeType: 'project' }],
    messageId: `message-${index}`,
  }))

test('a page of withheld rows costs the same number of queries however long it is', async () => {
  const runPage = async (count: number) => {
    const { calls, prisma } = buildGrantPrisma()
    const granted = await resolveGrantedScopeKeysForMessages(prisma, {
      channelId: 'channel-1',
      messages: withheldPage(count),
      organizationId: 'org-1',
      viewerChannelIds: ['channel-1'],
      viewerUserId: 'user-1',
    })
    assert.equal(granted.size, count)
    return calls
  }

  const short = await runPage(1)
  const long = await runPage(25)

  assert.deepEqual(short, ['disclosureGrant', 'scopeDisclosureGrant'])
  assert.deepEqual(long, short)
})

test('one granter is re-checked once for a page, and its grant lifts every row it covers', async () => {
  const { calls, prisma } = buildGrantPrisma({
    messageGrants: [
      { grantedByUserId: 'granter-1', messageId: 'message-0' },
      { grantedByUserId: 'granter-1', messageId: 'message-1' },
    ],
  })

  const granted = await resolveGrantedScopeKeysForMessages(prisma, {
    channelId: 'channel-1',
    messages: withheldPage(3),
    organizationId: 'org-1',
    viewerChannelIds: ['channel-1'],
    viewerUserId: 'user-1',
  })

  assert.deepEqual([...(granted.get('message-0') ?? [])], ['project:project-1'])
  assert.deepEqual([...(granted.get('message-1') ?? [])], ['project:project-1'])
  assert.deepEqual([...(granted.get('message-2') ?? [])], [])
  // The granter's live reach is resolved once, not once per grant row.
  assert.equal(calls.filter((call) => call === 'organizationMember').length, 1)
})

test('a message grant lifts only its own message, and a scope grant only its own agent', async () => {
  const { prisma } = buildGrantPrisma({
    scopeGrants: [{
      agentId: 'agent-1',
      grantedByUserId: 'granter-1',
      sourceScopeId: 'project-1',
      sourceScopeType: 'project',
    }],
  })

  const granted = await resolveGrantedScopeKeysForMessages(prisma, {
    channelId: 'channel-1',
    messages: withheldPage(2),
    organizationId: 'org-1',
    viewerChannelIds: ['channel-1'],
    viewerUserId: 'user-1',
  })

  assert.deepEqual([...(granted.get('message-0') ?? [])], [])
  assert.deepEqual([...(granted.get('message-1') ?? [])], ['project:project-1'])
})

test('the single-message resolver and the batched one answer identically', async () => {
  const grants = {
    messageGrants: [{ grantedByUserId: 'granter-1', messageId: 'message-0' }],
  }
  const single = await resolveGrantedDisclosureScopeKeys(buildGrantPrisma(grants).prisma, {
    agentId: 'agent-0',
    basis: [{ scopeId: 'project-1', scopeType: 'project' }],
    channelId: 'channel-1',
    messageId: 'message-0',
    organizationId: 'org-1',
    viewerChannelIds: ['channel-1'],
    viewerUserId: 'user-1',
  })
  const batched = await resolveGrantedScopeKeysForMessages(buildGrantPrisma(grants).prisma, {
    channelId: 'channel-1',
    messages: withheldPage(1),
    organizationId: 'org-1',
    viewerChannelIds: ['channel-1'],
    viewerUserId: 'user-1',
  })

  assert.deepEqual([...single], [...(batched.get('message-0') ?? [])])
})

test('an unrestricted page and an autonomous viewer never query grants at all', async () => {
  const unrestricted = buildGrantPrisma()
  const autonomous = buildGrantPrisma()

  await resolveGrantedScopeKeysForMessages(unrestricted.prisma, {
    channelId: 'channel-1',
    messages: [{ agentId: null, basis: [], messageId: 'message-0' }],
    organizationId: 'org-1',
    viewerChannelIds: ['channel-1'],
    viewerUserId: 'user-1',
  })
  await resolveGrantedScopeKeysForMessages(autonomous.prisma, {
    channelId: 'channel-1',
    messages: withheldPage(4),
    organizationId: 'org-1',
    viewerChannelIds: [],
    viewerUserId: null,
  })

  assert.deepEqual(unrestricted.calls, [])
  assert.deepEqual(autonomous.calls, [])
})
