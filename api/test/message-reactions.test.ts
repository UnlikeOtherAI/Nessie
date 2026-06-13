import assert from 'node:assert/strict'
import test from 'node:test'

import type { PrismaClient } from '@prisma/client'

import { toggleUserReaction } from '../src/services/message-reactions.js'

const input = {
  emoji: '\u{1F44D}',
  messageId: 'message-1',
  threadId: 'thread-1',
  userId: '00000000-0000-4000-8000-000000000001',
}

const expectedWhere = {
  messageId_userId_emoji: {
    emoji: input.emoji,
    messageId: input.messageId,
    userId: input.userId,
  },
}

const makePrisma = (inputExisting: {
  message?: { id: string } | null
  reaction?: { id: string } | null
}) => {
  const existing = {
    message:
      'message' in inputExisting ? inputExisting.message : { id: input.messageId },
    reaction: 'reaction' in inputExisting ? inputExisting.reaction : null,
  }
  const calls = {
    create: [] as unknown[],
    delete: [] as unknown[],
    findUnique: [] as unknown[],
    messageFindFirst: [] as unknown[],
  }
  const tx = {
    message: {
      findFirst: async (args: unknown) => {
        calls.messageFindFirst.push(args)
        return existing.message
      },
    },
    messageReaction: {
      create: async (args: unknown) => {
        calls.create.push(args)
        return { id: 'reaction-created' }
      },
      delete: async (args: unknown) => {
        calls.delete.push(args)
        return existing.reaction
      },
      findUnique: async (args: unknown) => {
        calls.findUnique.push(args)
        return existing.reaction
      },
    },
  }
  const prisma = {
    $transaction: async <T>(callback: (transaction: typeof tx) => Promise<T>) =>
      callback(tx),
  } as unknown as PrismaClient

  return { calls, prisma }
}

test('toggleUserReaction creates the current user reaction when absent', async () => {
  const { calls, prisma } = makePrisma({})

  const result = await toggleUserReaction(prisma, input)

  assert.deepEqual(result, { kind: 'created' })
  assert.deepEqual(calls.messageFindFirst, [
    {
      select: { id: true },
      where: {
        deletedAt: null,
        id: input.messageId,
        threadId: input.threadId,
      },
    },
  ])
  assert.deepEqual(calls.findUnique, [{ where: expectedWhere }])
  assert.deepEqual(calls.delete, [])
  assert.deepEqual(calls.create, [
    {
      data: {
        emoji: input.emoji,
        messageId: input.messageId,
        userId: input.userId,
      },
    },
  ])
})

test('toggleUserReaction deletes the current user reaction when present', async () => {
  const { calls, prisma } = makePrisma({ reaction: { id: 'reaction-1' } })

  const result = await toggleUserReaction(prisma, input)

  assert.deepEqual(result, { kind: 'deleted' })
  assert.deepEqual(calls.findUnique, [{ where: expectedWhere }])
  assert.deepEqual(calls.create, [])
  assert.deepEqual(calls.delete, [{ where: expectedWhere }])
})

test('toggleUserReaction rejects messages outside the requested thread', async () => {
  const { calls, prisma } = makePrisma({ message: null })

  const result = await toggleUserReaction(prisma, input)

  assert.deepEqual(result, { kind: 'not_found' })
  assert.equal(calls.messageFindFirst.length, 1)
  assert.deepEqual(calls.findUnique, [])
  assert.deepEqual(calls.create, [])
  assert.deepEqual(calls.delete, [])
})
