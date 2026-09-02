import assert from 'node:assert/strict'
import test from 'node:test'

import { Prisma, type PrismaClient } from '@prisma/client'

import { createThreadMessage } from '../src/services/message-create.js'

// The admin composers auto-save their drafts and retry an ambiguous send, so
// the create path takes a client idempotency key. A retry with the same key
// must resolve to the message the first attempt created — never a second copy
// and never a conflict a person reads as "your message failed".
//
// The fake models exactly the queries the service now makes: `message.findFirst`
// for the pre-check and the replay after a lost race, and a `message.create`
// that enforces the real unique index on `(thread_id, client_message_id)`.

type StoredMessage = {
  id: string
  threadId: string
  clientMessageId: string | null
  content: string
  role: string
  metadata: Record<string, unknown>
  reactions: unknown[]
  user: { id: string; displayName: string } | null
  agent: null
}

const makePrisma = (seed: StoredMessage[] = []) => {
  const stored = [...seed]
  const calls = { creates: 0, findFirsts: 0 }
  let nextId = stored.length + 1
  // Set to make the next create collide, as a concurrent attempt would.
  let raceWith: StoredMessage | null = null

  const prisma = {
    thread: {
      findUnique: async () => ({
        channel: {
          id: 'channel-1',
          agentBindings: [],
          members: [{ user: { id: 'user-1', displayName: 'User One' } }],
          organizationId: 'org-1',
          systemChannelType: null,
        },
      }),
    },
    message: {
      findFirst: async ({ where }: { where: { threadId: string; clientMessageId: string } }) => {
        calls.findFirsts += 1
        return stored.find(
          (row) =>
            row.threadId === where.threadId && row.clientMessageId === where.clientMessageId,
        ) ?? null
      },
      create: async ({ data }: { data: Record<string, unknown> }) => {
        calls.creates += 1
        if (raceWith) {
          // The winner landed between the pre-check and this insert.
          stored.push(raceWith)
          raceWith = null
          throw new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
            clientVersion: 'test',
            code: 'P2002',
            meta: { target: ['thread_id', 'client_message_id'] },
          })
        }
        const clientMessageId =
          typeof data.clientMessageId === 'string' ? data.clientMessageId : null
        if (
          clientMessageId
          && stored.some(
            (row) => row.threadId === data.threadId && row.clientMessageId === clientMessageId,
          )
        ) {
          throw new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
            clientVersion: 'test',
            code: 'P2002',
            meta: { target: ['thread_id', 'client_message_id'] },
          })
        }
        const created: StoredMessage = {
          agent: null,
          clientMessageId,
          content: String(data.content ?? ''),
          id: `message-${nextId++}`,
          metadata: {},
          reactions: [],
          role: 'user',
          threadId: String(data.threadId),
          user: { id: 'user-1', displayName: 'User One' },
        }
        stored.push(created)
        return created
      },
    },
    agent: { findMany: async () => [] },
    userAlert: { createMany: async ({ data }: { data: unknown[] }) => ({ count: data.length }) },
    messageThreadFollow: { createMany: async () => ({ count: 0 }) },
    $transaction: async (callback: (tx: unknown) => Promise<unknown>) => callback(prisma),
  } as unknown as PrismaClient

  return {
    calls,
    prisma,
    raceNextCreateWith: (message: StoredMessage) => {
      raceWith = message
    },
    stored,
  }
}

const send = (prisma: PrismaClient, clientMessageId?: string) =>
  createThreadMessage(prisma, {
    content: 'the same post, twice',
    threadId: 'thread-1',
    userId: 'user-1',
    ...(clientMessageId ? { clientMessageId } : {}),
  })

test('a send with no idempotency key behaves exactly as before', async () => {
  const { calls, prisma, stored } = makePrisma()
  const first = await send(prisma)
  const second = await send(prisma)
  assert.equal(first.kind, 'created')
  assert.equal(second.kind, 'created')
  assert.equal(stored.length, 2)
  // No key, no pre-check: the untouched path costs no extra query.
  assert.equal(calls.findFirsts, 0)
})

test('a retry carrying the same key replays the first message instead of posting twice', async () => {
  const { calls, prisma, stored } = makePrisma()
  const first = await send(prisma, 'draft-key-1')
  assert.equal(first.kind, 'created')

  const retry = await send(prisma, 'draft-key-1')
  assert.equal(retry.kind, 'replayed')
  if (retry.kind !== 'replayed' || first.kind !== 'created') return
  assert.equal(retry.message.id, first.message.id)
  assert.equal(stored.length, 1)
  // The replay answered from the pre-check, without a second insert.
  assert.equal(calls.creates, 1)
})

test('two different drafts in one thread keep their own keys and both post', async () => {
  const { prisma, stored } = makePrisma()
  const first = await send(prisma, 'draft-key-1')
  const second = await send(prisma, 'draft-key-2')
  assert.equal(first.kind, 'created')
  assert.equal(second.kind, 'created')
  assert.equal(stored.length, 2)
})

test('a key that loses the insert race replays the winner rather than failing', async () => {
  const { prisma, raceNextCreateWith, stored } = makePrisma()
  raceNextCreateWith({
    agent: null,
    clientMessageId: 'draft-key-1',
    content: 'the same post, twice',
    id: 'message-winner',
    metadata: {},
    reactions: [],
    role: 'user',
    threadId: 'thread-1',
    user: { id: 'user-1', displayName: 'User One' },
  })

  const result = await send(prisma, 'draft-key-1')
  assert.equal(result.kind, 'replayed')
  if (result.kind !== 'replayed') return
  assert.equal(result.message.id, 'message-winner')
  assert.equal(stored.length, 1)
})

test('a unique violation on a send with no key still surfaces as an error', () => {
  // The replay is reached only through the caller's own idempotency key; a
  // P2002 on a keyless send has nothing to resolve to and must stay an error.
  const { prisma, raceNextCreateWith } = makePrisma()
  raceNextCreateWith({
    agent: null,
    clientMessageId: null,
    content: 'the same post, twice',
    id: 'message-other',
    metadata: {},
    reactions: [],
    role: 'user',
    threadId: 'thread-1',
    user: { id: 'user-1', displayName: 'User One' },
  })
  return assert.rejects(send(prisma), /Unique constraint failed/)
})
