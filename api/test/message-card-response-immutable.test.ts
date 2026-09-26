import assert from 'node:assert/strict'
import test from 'node:test'

import type { PrismaClient } from '@prisma/client'

import { updateMessage, softDeleteMessage } from '../src/services/message-edit.js'

const CARD_ID = '11111111-1111-4111-8111-111111111111'
const AUTHOR = '00000000-0000-4000-8000-000000000001'

const cardResponseMetadata = {
  agentCardResponse: { actionKey: 'allow', cardId: CARD_ID, schemaVersion: 1 },
}

/**
 * Models the exact `select` the service asks for — `metadata` included, since
 * a cast fake is unityped and an unmodelled column reads back as `undefined`
 * rather than failing to compile.
 */
const makePrisma = (row: {
  deletedAt?: Date | null
  metadata?: unknown
  userId?: string
}) => {
  const calls = { findFirst: [] as unknown[], update: [] as unknown[] }
  const existing = {
    deletedAt: row.deletedAt ?? null,
    id: 'message-1',
    metadata: 'metadata' in row ? row.metadata : null,
    requiresConfirmation: false,
    thread: { channel: { adminOnlyPosting: false } },
    userId: row.userId ?? AUTHOR,
  }
  const delegates = {
    message: {
      findFirst: async (args: { select?: Record<string, boolean> }) => {
        calls.findFirst.push(args)
        if (!args.select) return existing
        // Honour the select, so a service reading an unselected field sees
        // `undefined` here exactly as it would against Postgres.
        return Object.fromEntries(
          Object.keys(args.select).map((key) => [key, (existing as Record<string, unknown>)[key]]),
        )
      },
      update: async (args: unknown) => {
        calls.update.push(args)
        return { ...existing, basisScopes: [], reactions: [] }
      },
    },
  }
  const prisma = {
    ...delegates,
    $transaction: async <T>(run: (tx: typeof delegates) => Promise<T>): Promise<T> => run(delegates),
  }
  return { calls, prisma: prisma as unknown as PrismaClient }
}

const input = {
  content: 'Allow',
  messageId: 'message-1',
  threadId: 'thread-1',
  userId: AUTHOR,
}

test('the edit service selects metadata, so the guard has something to read', async () => {
  const { calls, prisma } = makePrisma({ metadata: cardResponseMetadata })
  await updateMessage(prisma, input)
  const [args] = calls.findFirst as [{ select: Record<string, boolean> }]
  assert.equal(args.select.metadata, true)
})

test('editing a card-press message is refused and writes nothing', async () => {
  const { calls, prisma } = makePrisma({ metadata: cardResponseMetadata })
  const result = await updateMessage(prisma, { ...input, content: 'Deny' })
  assert.deepEqual(result, { kind: 'immutable', record: 'card_response' })
  assert.equal(calls.update.length, 0)
})

test('editing a research card is refused and writes nothing; deleting it stays allowed', async () => {
  const researchCard = { researchRunRef: { runId: CARD_ID, schemaVersion: 1 } }
  const { calls, prisma } = makePrisma({ metadata: researchCard })
  const result = await updateMessage(prisma, { ...input, content: 'Another topic' })
  assert.deepEqual(result, { kind: 'immutable', record: 'research_card' })
  assert.equal(calls.update.length, 0)
  const deleted = await softDeleteMessage(prisma, {
    messageId: input.messageId, threadId: input.threadId, userId: AUTHOR,
  })
  assert.equal(deleted.kind, 'deleted')
  // Its author is the only one who could edit it, so anyone else is still told 403 first.
  const other = makePrisma({ metadata: researchCard, userId: '00000000-0000-4000-8000-000000000002' })
  assert.equal((await updateMessage(other.prisma, input)).kind, 'forbidden')
})

test('the author may still edit an ordinary message, and one carrying the card itself', async () => {
  for (const metadata of [
    null,
    { agentCard: { cardId: CARD_ID, schemaVersion: 1 } },
  ]) {
    const { calls, prisma } = makePrisma({ metadata })
    const result = await updateMessage(prisma, input)
    assert.equal(result.kind, 'updated')
    assert.equal(calls.update.length, 1)
  }
})

test('a non-author is refused before the immutability check, keeping 403 the answer', async () => {
  const { prisma } = makePrisma({
    metadata: cardResponseMetadata,
    userId: '00000000-0000-4000-8000-000000000002',
  })
  const result = await updateMessage(prisma, input)
  assert.equal(result.kind, 'forbidden')
})

test('deleting a card-press message stays allowed — a tombstone changes nothing on the card', async () => {
  const { calls, prisma } = makePrisma({ metadata: cardResponseMetadata })
  const result = await softDeleteMessage(prisma, {
    messageId: input.messageId,
    threadId: input.threadId,
    userId: AUTHOR,
  })
  assert.equal(result.kind, 'deleted')
  assert.equal(calls.update.length, 1)
})
