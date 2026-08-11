import assert from 'node:assert/strict'
import test from 'node:test'

import type { Channel, PrismaClient } from '@prisma/client'

import { mapChannelRecord } from '../src/services/channel-records.js'
import { listChannelsForUser } from '../src/services/channels.js'

const organizationId = '00000000-0000-4000-8000-000000000001'
const projectId = '00000000-0000-4000-8000-000000000002'
const teamId = '00000000-0000-4000-8000-000000000003'
const userId = '00000000-0000-4000-8000-000000000004'
const channelId = '00000000-0000-4000-8000-000000000005'
const quietChannelId = '00000000-0000-4000-8000-000000000006'
const threadId = '00000000-0000-4000-8000-000000000007'
const quietThreadId = '00000000-0000-4000-8000-000000000008'

const lastMessageAt = new Date('2026-08-10T18:45:00.000Z')

const channelRow = (overrides: Partial<Channel> = {}) => ({
  archivedAt: null,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  description: null,
  dmKey: null,
  id: channelId,
  label: 'design',
  organizationId,
  projectId,
  slug: 'design',
  systemChannelType: null,
  teamId,
  topic: 'What we ship',
  type: 'standard',
  updatedAt: new Date('2026-01-01T00:00:00.000Z'),
  visibility: 'public',
  ...overrides,
})

const teamShape = {
  name: 'Core',
  project: { id: projectId, name: 'Nessie' },
}

// The unread walk and the recency aggregate are two distinct queries; the fake
// answers each by the SQL it was handed, which also pins that the recency read
// is genuinely separate from the unread tail scan.
const answerRawQuery = (
  query: { sql: string },
  rows: { unread: unknown[]; lastMessage: unknown[] },
): unknown[] => (query.sql.includes('unread_count') ? rows.unread : rows.lastMessage)

test('the channel list carries lastMessageAt, null for a channel with no messages', async () => {
  const prisma = {
    channel: {
      findMany: async () => [
        {
          ...channelRow(),
          threads: [{ id: threadId }],
          members: [{ role: 'member', muted: false }],
          team: teamShape,
        },
        {
          ...channelRow({ id: quietChannelId, label: 'empty', slug: 'empty' }),
          threads: [{ id: quietThreadId }],
          members: [{ role: 'member', muted: false }],
          team: teamShape,
        },
      ],
    },
    $queryRaw: async (query: { sql: string }) =>
      answerRawQuery(query, {
        unread: [
          { thread_id: threadId, unread_count: 3n },
          { thread_id: quietThreadId, unread_count: 0n },
        ],
        // A message-less thread produces no aggregate row at all.
        lastMessage: [{ thread_id: threadId, last_message_at: lastMessageAt }],
      }),
  } as unknown as PrismaClient

  const channels = await listChannelsForUser(prisma, userId, organizationId)

  assert.equal(channels.length, 2)
  assert.equal(channels[0]?.lastMessageAt, lastMessageAt.toISOString())
  assert.equal(channels[0]?.unreadCount, 3)
  assert.equal(channels[1]?.lastMessageAt, null)
})

test('a single channel record carries lastMessageAt too, so a mutation response never blanks it', async () => {
  const prisma = {
    thread: {
      findFirst: async () => ({ id: threadId }),
    },
    $queryRaw: async (query: { sql: string }) =>
      answerRawQuery(query, {
        unread: [{ thread_id: threadId, unread_count: 0n }],
        lastMessage: [{ thread_id: threadId, last_message_at: lastMessageAt }],
      }),
  } as unknown as PrismaClient

  const record = await mapChannelRecord(
    prisma,
    { ...channelRow(), team: teamShape } as unknown as Parameters<typeof mapChannelRecord>[1],
    userId,
  )

  assert.equal(record.lastMessageAt, lastMessageAt.toISOString())
})

test('a single channel record reports null lastMessageAt for an empty thread', async () => {
  const prisma = {
    thread: {
      findFirst: async () => ({ id: quietThreadId }),
    },
    $queryRaw: async (query: { sql: string }) =>
      answerRawQuery(query, {
        unread: [{ thread_id: quietThreadId, unread_count: 0n }],
        lastMessage: [],
      }),
  } as unknown as PrismaClient

  const record = await mapChannelRecord(
    prisma,
    {
      ...channelRow({ id: quietChannelId, label: 'empty', slug: 'empty' }),
      team: teamShape,
    } as unknown as Parameters<typeof mapChannelRecord>[1],
    userId,
  )

  assert.equal(record.lastMessageAt, null)
})
