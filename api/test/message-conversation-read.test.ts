import assert from 'node:assert/strict'
import test from 'node:test'
import type { PrismaClient } from '@prisma/client'
import { loadUnreadCountsByThread } from '@nessie/team-admin'

import { markThreadRead } from '../src/services/message-read-state.js'

const THREAD_ID = '00000000-0000-4000-8000-000000000001'
const ROOT_ID = '00000000-0000-4000-8000-000000000002'
const USER_ID = '00000000-0000-4000-8000-000000000003'

test('opening a reply conversation advances only that root cursor', async () => {
  const rootCreatedAt = new Date('2026-08-13T10:00:00.000Z')
  const replyCreatedAt = new Date('2026-08-13T10:02:00.000Z')
  let sql = ''
  const prisma = {
    threadReadState: {
      findUnique: async () => ({ lastReadAt: new Date('2026-08-13T09:00:00.000Z') }),
    },
    message: {
      findFirst: async ({ where }: { where: { id?: string } }) =>
        where.id === ROOT_ID
          ? { agentId: null, basisScopes: [], createdAt: rootCreatedAt, id: ROOT_ID }
          : null,
      findMany: async () => [{
        agentId: null,
        basisScopes: [],
        createdAt: replyCreatedAt,
        id: '00000000-0000-4000-8000-000000000004',
      }],
    },
    $executeRaw: async (query: { sql: string }) => { sql = query.sql },
  } as unknown as PrismaClient

  assert.equal(await markThreadRead(prisma, {
    organizationId: '00000000-0000-4000-8000-000000000005',
    rootMessageId: ROOT_ID,
    threadId: THREAD_ID,
    userId: USER_ID,
  }), true)
  assert.match(sql, /ON CONFLICT \("root_message_id", "user_id"\) DO UPDATE/)
  assert.match(sql, /EXCLUDED\."last_read_at" > "message_conversation_read_states"\."last_read_at"/)
  assert.match(sql, /last_read_message_id/)
})

test('a missing or deleted client cursor cannot mark a conversation read', async () => {
  let wrote = false
  const prisma = {
    threadReadState: { findUnique: async () => null },
    message: {
      findFirst: async ({ where }: { where: { id?: string } }) =>
        where.id === ROOT_ID
          ? { agentId: null, basisScopes: [], createdAt: new Date(), id: ROOT_ID }
          : null,
      findMany: async () => [],
    },
    $executeRaw: async () => { wrote = true },
  } as unknown as PrismaClient

  assert.equal(await markThreadRead(prisma, {
    organizationId: '00000000-0000-4000-8000-000000000005',
    rootMessageId: ROOT_ID,
    lastReadMessageId: '00000000-0000-4000-8000-000000000099',
    threadId: THREAD_ID,
    userId: USER_ID,
  }), false)
  assert.equal(wrote, false)
})

test('the unread query resolves a message-level cursor before the legacy container cursor', async () => {
  let sql = ''
  const prisma = {
    $queryRaw: async (query: { sql: string }) => {
      sql = query.sql
      return [{ thread_id: THREAD_ID, unread_count: 2n }]
    },
  } as unknown as PrismaClient

  const counts = await loadUnreadCountsByThread(prisma, [THREAD_ID], USER_ID)

  assert.equal(counts.get(THREAD_ID), 2)
  assert.match(sql, /message_conversation_read_states/)
  assert.match(sql, /COALESCE\(m\.root_message_id, m\.id\)/)
  assert.match(sql, /COALESCE\(mcrs\.last_read_at, trs\.last_read_at\)/)
})
