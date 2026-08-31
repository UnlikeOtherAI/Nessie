import assert from 'node:assert/strict'
import test from 'node:test'

import type { PrismaClient } from '@prisma/client'

import { listUnreadDirectMessages } from '../src/services/unread-direct-messages.js'

const organizationId = '00000000-0000-4000-8000-000000000001'
const projectId = '00000000-0000-4000-8000-000000000002'
const teamId = '00000000-0000-4000-8000-000000000003'
const userId = '00000000-0000-4000-8000-000000000004'
const dmChannelId = '00000000-0000-4000-8000-000000000005'
const dmThreadId = '00000000-0000-4000-8000-000000000006'
const standardChannelId = '00000000-0000-4000-8000-000000000007'
const standardThreadId = '00000000-0000-4000-8000-000000000008'
const unreadMessageId = '00000000-0000-4000-8000-000000000009'
const foreignUserId = '00000000-0000-4000-8000-000000000010'
const visibleAgentId = '00000000-0000-4000-8000-000000000011'

const channel = (input: {
  id: string
  label: string
  threadId: string
  type: 'dm' | 'standard'
}) => ({
  archivedAt: null,
  createdAt: new Date('2026-08-01T00:00:00.000Z'),
  description: null,
  dmKey: input.type === 'dm'
    ? [organizationId, teamId, userId, foreignUserId].join(':')
    : null,
  id: input.id,
  label: input.label,
  organizationId,
  slug: null,
  systemChannelType: null,
  teamId,
  threads: [{ id: input.threadId }],
  members: [{ muted: false, role: 'member' }],
  team: {
    name: 'Core',
    project: { channelRoot: false, id: projectId, name: 'Nessie' },
  },
  topic: null,
  type: input.type,
  updatedAt: new Date('2026-08-01T00:00:00.000Z'),
  visibility: input.type === 'dm' ? 'private' : 'public',
})

const message = {
  agentId: null,
  basisScopes: [],
  content: 'Could you review the proposal?',
  createdAt: new Date('2026-08-31T11:00:00.000Z'),
  deletedAt: null,
  id: unreadMessageId,
  threadId: dmThreadId,
}

const makePrisma = (options: { unreadCount?: number; restricted?: boolean } = {}) => {
  const unreadCount = options.unreadCount ?? 2
  const agents = [
    {
      id: visibleAgentId,
      organizationId,
      ownerMembership: { deactivatedAt: null },
      ownerUserId: userId,
      parentAgentId: null,
      systemManaged: false,
    },
    {
      id: '00000000-0000-4000-8000-000000000012',
      organizationId,
      ownerMembership: { deactivatedAt: null },
      ownerUserId: userId,
      parentAgentId: null,
      systemManaged: true,
    },
    {
      id: '00000000-0000-4000-8000-000000000013',
      organizationId,
      ownerMembership: { deactivatedAt: null },
      ownerUserId: userId,
      parentAgentId: visibleAgentId,
      systemManaged: false,
    },
    {
      id: '00000000-0000-4000-8000-000000000014',
      organizationId,
      ownerMembership: { deactivatedAt: null },
      ownerUserId: foreignUserId,
      parentAgentId: null,
      systemManaged: false,
    },
  ]
  return {
    agent: {
      findMany: async (args: {
        select: { id: true }
        where: {
          OR: Array<{
            ownerMembership?: { deactivatedAt: null }
            ownerUserId?: string
            parentAgentId?: null
          }>
          organizationId: string
          systemManaged: boolean
        }
      }) => {
        assert.deepEqual(args.select, { id: true })
        return agents
          .filter((agent) =>
            agent.organizationId === args.where.organizationId
            && agent.systemManaged === args.where.systemManaged
            && args.where.OR.some((visibility) =>
              agent.ownerMembership?.deactivatedAt === visibility.ownerMembership?.deactivatedAt
              && agent.ownerUserId === visibility.ownerUserId
              && agent.parentAgentId === visibility.parentAgentId,
            ),
          )
          .map((agent) => ({ id: agent.id }))
      },
    },
    channel: {
      findMany: async () => [
        channel({ id: dmChannelId, label: 'Ada Lovelace', threadId: dmThreadId, type: 'dm' }),
        channel({ id: standardChannelId, label: 'general', threadId: standardThreadId, type: 'standard' }),
      ],
    },
    message: {
      findMany: async () => [{
        ...message,
        basisScopes: options.restricted
          ? [{ scopeId: foreignUserId, scopeType: 'user' }]
          : [],
      }],
    },
    organizationMember: {
      findFirst: async () => ({ id: 'membership' }),
    },
    channelMember: {
      findMany: async () => [{ channelId: dmChannelId }],
    },
    teamMember: {
      findMany: async () => [],
    },
    projectMember: {
      findMany: async () => [],
    },
    disclosureGrant: {
      findMany: async () => [],
    },
    $queryRaw: async (query: { sql: string }) => {
      if (query.sql.includes('unread_count')) {
        return [
          { thread_id: dmThreadId, unread_count: BigInt(unreadCount) },
          { thread_id: standardThreadId, unread_count: 7n },
        ]
      }
      if (query.sql.includes('last_message_at')) return []
      assert.match(query.sql, /message_conversation_read_states/)
      assert.match(query.sql, /DISTINCT ON \(m\.thread_id\)/)
      return unreadCount > 0 ? [{ message_id: unreadMessageId, thread_id: dmThreadId }] : []
    },
  } as unknown as PrismaClient
}

test('the unread direct-message inbox projects the latest unread DM, not channel activity', async () => {
  const items = await listUnreadDirectMessages(makePrisma(), { organizationId, userId })

  assert.deepEqual(items, [{
    channelId: dmChannelId,
    channelLabel: 'Ada Lovelace',
    latestMessage: {
      content: 'Could you review the proposal?',
      createdAt: '2026-08-31T11:00:00.000Z',
    },
    unreadCount: 2,
  }])
})

test('a disclosure-restricted unread DM leaves the navigation row but never exposes its preview', async () => {
  const items = await listUnreadDirectMessages(
    makePrisma({ restricted: true }),
    { organizationId, userId },
  )

  assert.deepEqual(items[0]?.latestMessage, {
    content: '',
    createdAt: '2026-08-31T11:00:00.000Z',
    restricted: true,
  })
})

test('the unread direct-message inbox is empty when no direct message is unread', async () => {
  const items = await listUnreadDirectMessages(
    makePrisma({ unreadCount: 0 }),
    { organizationId, userId },
  )

  assert.deepEqual(items, [])
})
