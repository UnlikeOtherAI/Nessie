import assert from 'node:assert/strict'
import test from 'node:test'

import type { PrismaClient } from '@prisma/client'
import type { WsScope } from '@nessie/schemas'

import { createRequestHelpers } from '../src/lib/request-helpers.js'
import { bindAgentToChannel } from '@nessie/team-admin'

const organizationId = '00000000-0000-4000-8000-000000000001'
const otherOrganizationId = '00000000-0000-4000-8000-000000000002'
const userId = '00000000-0000-4000-8000-000000000003'

const publicChannelId = '00000000-0000-4000-8000-000000000010'
const privateMemberChannelId = '00000000-0000-4000-8000-000000000011'
const privateNonMemberChannelId = '00000000-0000-4000-8000-000000000012'
const foreignChannelId = '00000000-0000-4000-8000-000000000013'

const visibleAgentId = '00000000-0000-4000-8000-000000000020'
const hiddenAgentId = '00000000-0000-4000-8000-000000000021'

type ChannelFixture = {
  members: { id: string }[]
  organizationId: string
  systemChannelType: string | null
  type: string
  visibility: string
}

const channelFixtures: Record<string, ChannelFixture> = {
  [publicChannelId]: {
    members: [],
    organizationId,
    systemChannelType: null,
    type: 'standard',
    visibility: 'public',
  },
  [privateMemberChannelId]: {
    members: [{ id: 'membership-1' }],
    organizationId,
    systemChannelType: null,
    type: 'standard',
    visibility: 'private',
  },
  [privateNonMemberChannelId]: {
    members: [],
    organizationId,
    systemChannelType: null,
    type: 'standard',
    visibility: 'private',
  },
  [foreignChannelId]: {
    members: [{ id: 'membership-2' }],
    organizationId: otherOrganizationId,
    systemChannelType: null,
    type: 'standard',
    visibility: 'private',
  },
}

const buildPrisma = (): PrismaClient =>
  ({
    channel: {
      findUnique: async ({ where }: { where: { id: string } }) =>
        channelFixtures[where.id] ?? null,
    },
    agent: {
      count: async ({ where }: { where: { id?: string } }) =>
        where.id === visibleAgentId ? 1 : 0,
    },
  }) as unknown as PrismaClient

test('filterAuthorizedScopes rejects a private channel the user is not a member of', async () => {
  const helpers = createRequestHelpers(buildPrisma())
  const requested: WsScope[] = [{ kind: 'channel', channelId: privateNonMemberChannelId }]

  const authorized = await helpers.filterAuthorizedScopes(userId, organizationId, requested)

  assert.deepEqual(authorized, [])
})

test('filterAuthorizedScopes admits a public channel without membership', async () => {
  const helpers = createRequestHelpers(buildPrisma())
  const requested: WsScope[] = [{ kind: 'channel', channelId: publicChannelId }]

  const authorized = await helpers.filterAuthorizedScopes(userId, organizationId, requested)

  assert.deepEqual(authorized, requested)
})

test('filterAuthorizedScopes admits a private channel the user is a member of', async () => {
  const helpers = createRequestHelpers(buildPrisma())
  const requested: WsScope[] = [{ kind: 'channel', channelId: privateMemberChannelId }]

  const authorized = await helpers.filterAuthorizedScopes(userId, organizationId, requested)

  assert.deepEqual(authorized, requested)
})

test('filterAuthorizedScopes rejects a channel that belongs to another organization', async () => {
  const helpers = createRequestHelpers(buildPrisma())
  const requested: WsScope[] = [{ kind: 'channel', channelId: foreignChannelId }]

  const authorized = await helpers.filterAuthorizedScopes(userId, organizationId, requested)

  assert.deepEqual(authorized, [])
})

test('filterAuthorizedScopes rejects an organization scope for a different tenant', async () => {
  const helpers = createRequestHelpers(buildPrisma())
  const requested: WsScope[] = [{ kind: 'organization', organizationId: otherOrganizationId }]

  const authorized = await helpers.filterAuthorizedScopes(userId, organizationId, requested)

  assert.deepEqual(authorized, [])
})

test('filterAuthorizedScopes admits the caller organization scope', async () => {
  const helpers = createRequestHelpers(buildPrisma())
  const requested: WsScope[] = [{ kind: 'organization', organizationId }]

  const authorized = await helpers.filterAuthorizedScopes(userId, organizationId, requested)

  assert.deepEqual(authorized, requested)
})

test('filterAuthorizedScopes only keeps agent scopes the user can see', async () => {
  const helpers = createRequestHelpers(buildPrisma())
  const requested: WsScope[] = [
    { kind: 'agent', agentId: visibleAgentId },
    { kind: 'agent', agentId: hiddenAgentId },
  ]

  const authorized = await helpers.filterAuthorizedScopes(userId, organizationId, requested)

  assert.deepEqual(authorized, [{ kind: 'agent', agentId: visibleAgentId }])
})

test('filterAuthorizedScopes drops the private members of a mixed scope set', async () => {
  const helpers = createRequestHelpers(buildPrisma())
  const requested: WsScope[] = [
    { kind: 'organization', organizationId },
    { kind: 'channel', channelId: publicChannelId },
    { kind: 'channel', channelId: privateNonMemberChannelId },
    { kind: 'channel', channelId: foreignChannelId },
  ]

  const authorized = await helpers.filterAuthorizedScopes(userId, organizationId, requested)

  assert.deepEqual(authorized, [
    { kind: 'organization', organizationId },
    { kind: 'channel', channelId: publicChannelId },
  ])
})

test('bindAgentToChannel refuses an agent from another organization', async () => {
  let upsertCalled = false
  const prisma = {
    agent: {
      findFirst: async ({
        where,
      }: {
        where: { id: string; organizationId: string }
      }) =>
        // The route passes the caller's organization; a cross-tenant agent id
        // never matches, so the org-scoped lookup returns null.
        where.organizationId === organizationId && where.id === visibleAgentId
          ? {
              agentKind: 'shared',
              delegationMode: null,
              model: null,
              name: 'Local agent',
              provider: null,
              role: 'researcher',
              surfacePolicy: null,
              systemManaged: false,
              systemPrompt: null,
              toolPolicy: null,
            }
          : null,
    },
    channel: {
      findFirst: async () => ({ systemChannelType: null }),
    },
    agentBinding: {
      upsert: async () => {
        upsertCalled = true
        return {}
      },
    },
  } as unknown as PrismaClient

  const result = await bindAgentToChannel(prisma, {
    agentId: hiddenAgentId,
    channelId: privateMemberChannelId,
    organizationId,
  })

  assert.equal(result, null)
  assert.equal(upsertCalled, false)
})
