import assert from 'node:assert/strict'
import test from 'node:test'
import type { PrismaClient } from '@prisma/client'
import { loadUnreadCountsByThread } from '@nessie/workspace-admin'

import { markThreadRead } from '../src/services/messages.js'

const THREAD_ID = '00000000-0000-4000-8000-000000000001'
const ROOT_ID = '00000000-0000-4000-8000-000000000002'
const USER_ID = '00000000-0000-4000-8000-000000000003'

test('opening a reply conversation advances only that root cursor', async () => {
  const rootCreatedAt = new Date('2026-08-13T10:00:00.000Z')
  const replyCreatedAt = new Date('2026-08-13T10:02:00.000Z')
  let readInput: unknown
  const prisma = {
    threadReadState: {
      findUnique: async () => ({ lastReadAt: new Date('2026-08-13T09:00:00.000Z') }),
    },
    message: {
      findFirst: async ({ where }: { where: { OR?: unknown } }) =>
        where.OR ? { createdAt: replyCreatedAt } : { createdAt: rootCreatedAt },
    },
    messageConversationReadState: {
      upsert: async (input: unknown) => {
        readInput = input
      },
    },
  } as unknown as PrismaClient

  assert.equal(await markThreadRead(prisma, {
    rootMessageId: ROOT_ID,
    threadId: THREAD_ID,
    userId: USER_ID,
  }), true)
  assert.deepEqual(readInput, {
    where: { rootMessageId_userId: { rootMessageId: ROOT_ID, userId: USER_ID } },
    create: { rootMessageId: ROOT_ID, userId: USER_ID, lastReadAt: replyCreatedAt },
    update: { lastReadAt: replyCreatedAt },
  })
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
