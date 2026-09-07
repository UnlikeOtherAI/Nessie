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
    channel: { findMany: async () => [] },
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
  channels?: Array<{ id: string; visibility: string }>
} = {}) => {
  const calls: string[] = []
  const prisma = {
    agent: { findMany: async () => [] },
    channel: { findMany: async () => { calls.push('channel'); return input.channels ?? [] } },
    channelMember: { findMany: async () => { calls.push('channelMember'); return [{ channelId: 'channel-1' }, { channelId: 'private-channel' }, { channelId: 'public-channel' }] } },
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


const privateLineage = [{ sourceAuthorUserId: 'author-1', sourceChannelId: 'private-channel' }]
const privateBasis = [{ scopeId: 'private-channel', scopeType: 'channel' }]

test('a message grant over private lineage needs the sole original author', async () => {
  const input = {
    agentId: 'agent-1',
    basis: privateBasis,
    channelId: 'destination-channel',
    disclosureSources: privateLineage,
    messageId: 'message-1',
    organizationId: 'org-1',
    viewerChannelIds: ['destination-channel'],
    viewerUserId: 'viewer-1',
  }
  const authorGrant = await resolveGrantedDisclosureScopeKeys(buildGrantPrisma({
    messageGrants: [{ grantedByUserId: 'author-1', messageId: 'message-1' }],
  }).prisma, input)
  const otherGrant = await resolveGrantedDisclosureScopeKeys(buildGrantPrisma({
    messageGrants: [{ grantedByUserId: 'other-user', messageId: 'message-1' }],
  }).prisma, input)

  assert.deepEqual([...authorGrant], ['channel:private-channel'])
  assert.deepEqual([...otherGrant], [])
})

test('standing scope grants never lift private conversation lineage', async () => {
  const { prisma } = buildGrantPrisma({
    scopeGrants: [{
      agentId: 'agent-1',
      grantedByUserId: 'author-1',
      sourceScopeId: 'private-channel',
      sourceScopeType: 'channel',
    }],
  })
  const granted = await resolveGrantedDisclosureScopeKeys(prisma, {
    agentId: 'agent-1',
    basis: privateBasis,
    channelId: 'destination-channel',
    disclosureSources: privateLineage,
    messageId: 'message-1',
    organizationId: 'org-1',
    viewerChannelIds: ['destination-channel'],
    viewerUserId: 'viewer-1',
  })

  assert.deepEqual([...granted], [])
})

test('unattributed legacy non-public channel bases fail closed while public bases keep grants', async () => {
  const grants = {
    messageGrants: [{ grantedByUserId: 'granter-1', messageId: 'message-1' }],
    scopeGrants: [{
      agentId: 'agent-1',
      grantedByUserId: 'granter-1',
      sourceScopeId: 'private-channel',
      sourceScopeType: 'channel',
    }],
    channels: [
      { id: 'private-channel', visibility: 'private' },
      { id: 'private-channel-2', visibility: 'private' },
      { id: 'public-channel', visibility: 'public' },
    ],
  }
  const legacyPrivate = await resolveGrantedDisclosureScopeKeys(buildGrantPrisma(grants).prisma, {
    agentId: 'agent-1',
    basis: privateBasis,
    channelId: 'destination-channel',
    messageId: 'message-1',
    organizationId: 'org-1',
    viewerChannelIds: ['destination-channel'],
    viewerUserId: 'viewer-1',
  })
  const publicMessage = await resolveGrantedDisclosureScopeKeys(buildGrantPrisma({
    ...grants,
    messageGrants: [{ grantedByUserId: 'granter-1', messageId: 'message-2' }],
  }).prisma, {
    agentId: null,
    basis: [{ scopeId: 'public-channel', scopeType: 'channel' }],
    channelId: 'destination-channel',
    messageId: 'message-2',
    organizationId: 'org-1',
    viewerChannelIds: ['destination-channel'],
    viewerUserId: 'viewer-1',
  })

  assert.deepEqual([...legacyPrivate], [])
  assert.deepEqual([...publicMessage], ['channel:public-channel'])
})

test('private-lineage policy agrees for batched and single grant reads', async () => {
  const grants = {
    messageGrants: [{ grantedByUserId: 'author-1', messageId: 'message-1' }],
  }
  const single = await resolveGrantedDisclosureScopeKeys(buildGrantPrisma(grants).prisma, {
    agentId: 'agent-1',
    basis: privateBasis,
    channelId: 'destination-channel',
    disclosureSources: privateLineage,
    messageId: 'message-1',
    organizationId: 'org-1',
    viewerChannelIds: ['destination-channel'],
    viewerUserId: 'viewer-1',
  })
  const batched = await resolveGrantedScopeKeysForMessages(buildGrantPrisma(grants).prisma, {
    channelId: 'destination-channel',
    messages: [{
      agentId: 'agent-1',
      basis: privateBasis,
      disclosureSources: privateLineage,
      messageId: 'message-1',
    }],
    organizationId: 'org-1',
    viewerChannelIds: ['destination-channel'],
    viewerUserId: 'viewer-1',
  })

  assert.deepEqual([...single], [...(batched.get('message-1') ?? [])])
})


test('a partial private-lineage backfill cannot authorize an uncovered private basis', async () => {
  const granted = await resolveGrantedDisclosureScopeKeys(buildGrantPrisma({
    channels: [
      { id: 'private-channel', visibility: 'private' },
      { id: 'private-channel-2', visibility: 'private' },
    ],
    messageGrants: [{ grantedByUserId: 'author-1', messageId: 'message-1' }],
  }).prisma, {
    agentId: 'agent-1',
    basis: [
      { scopeId: 'private-channel', scopeType: 'channel' },
      { scopeId: 'private-channel-2', scopeType: 'channel' },
    ],
    channelId: 'destination-channel',
    disclosureSources: privateLineage,
    messageId: 'message-1',
    organizationId: 'org-1',
    viewerChannelIds: ['destination-channel'],
    viewerUserId: 'viewer-1',
  })

  assert.deepEqual([...granted], [])
})
