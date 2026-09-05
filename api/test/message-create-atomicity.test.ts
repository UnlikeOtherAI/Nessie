import assert from 'node:assert/strict'
import test from 'node:test'

import type { PrismaClient } from '@prisma/client'

import { createThreadMessage } from '../src/services/message-create.js'

/**
 * Everything a send writes commits together.
 *
 * The agent-mention merge and the "Also send to #channel" copy used to be two
 * independent writes *after* the create transaction had already committed. A
 * crash in between left a committed message whose stored mentions omitted every
 * agent mention — indistinguishable from a message that had none, while the
 * client already held a response saying otherwise — or a reply whose channel
 * copy never appeared.
 *
 * This fake refuses any message write outside the transaction, so a regression
 * fails rather than merely losing atomicity somewhere invisible.
 */
const makePrisma = () => {
  const inTransaction: unknown[] = []
  const messageRow = (data: { metadata?: unknown }) => ({
    id: `message-${inTransaction.length}`,
    role: 'user',
    content: 'a reply',
    metadata: data.metadata ?? {},
    reactions: [],
    createdAt: new Date('2026-09-05T10:00:00.000Z'),
    user: { id: 'user-1', displayName: 'User One' },
    agent: null,
  })
  const tx = {
    message: {
      create: async (input: { data: { metadata?: unknown } }) => {
        inTransaction.push(input)
        return messageRow(input.data)
      },
      findUnique: async () => ({
        deletedAt: null,
        id: 'root-1',
        rootMessageId: null,
        threadId: 'thread-1',
      }),
    },
    messageThreadFollow: { createMany: async () => ({ count: 0 }) },
    userAlert: { createMany: async ({ data }: { data: unknown[] }) => ({ count: data.length }) },
    $queryRaw: async () => [{
      last_reply_at: new Date('2026-09-05T10:00:00.000Z'),
      reply_count: 1,
      reply_participant_ids: ['user-1'],
    }],
  }
  const prisma = {
    thread: {
      findUnique: async () => ({
        channel: {
          agentBindings: [{
            agent: {
              agentKind: 'shared',
              id: 'agent-bound',
              name: 'Bound',
              role: 'assistant',
              systemPrompt: null,
            },
            principalUserId: null,
          }],
          id: 'channel-1',
          members: [{ user: { id: 'user-1', displayName: 'User One' } }],
          organizationId: 'org-1',
          systemChannelType: null,
        },
      }),
    },
    agent: { findMany: async () => [] },
    message: {
      create: async () => {
        throw new Error('a message must never be created outside the send transaction')
      },
      update: async () => {
        throw new Error('message metadata must be written by the create, not a later update')
      },
    },
    $transaction: async (callback: (client: unknown) => Promise<unknown>) => callback(tx),
  } as unknown as PrismaClient
  return { inTransaction, prisma }
}

test('a reply, its agent mentions and its channel copy are written in one transaction', async () => {
  const { inTransaction, prisma } = makePrisma()

  const result = await createThreadMessage(prisma, {
    alsoSendToChannel: true,
    content: '@Bound please take this',
    rootMessageId: 'root-1',
    threadId: 'thread-1',
    userId: 'user-1',
  })

  assert.equal(result.kind, 'created')
  if (result.kind !== 'created') return
  assert.ok(result.broadcastMessage, 'the channel copy is returned to the caller')

  // Two writes, both inside the transaction: the reply and its channel copy.
  assert.equal(inTransaction.length, 2)
  const [reply, copy] = inTransaction as Array<{
    data: { metadata: { mentions: { agentIds: string[] }; replyBroadcast?: unknown } }
  }>

  // The mention merge is part of the row the transaction commits, not a
  // follow-up update.
  assert.deepEqual(reply?.data.metadata.mentions.agentIds, ['agent-bound'])
  assert.equal(reply?.data.metadata.replyBroadcast, undefined)
  assert.deepEqual(copy?.data.metadata.replyBroadcast, { rootMessageId: 'root-1' })
  assert.deepEqual(copy?.data.metadata.mentions.agentIds, ['agent-bound'])
})

test('a top-level post with no agent mention still writes its mentions once', async () => {
  const { inTransaction, prisma } = makePrisma()

  const result = await createThreadMessage(prisma, {
    content: 'nothing to see here',
    threadId: 'thread-1',
    userId: 'user-1',
  })

  assert.equal(result.kind, 'created')
  assert.equal(inTransaction.length, 1)
  const [created] = inTransaction as Array<{
    data: { metadata: { mentions: unknown } }
  }>
  assert.deepEqual(created?.data.metadata.mentions, {
    agentIds: [],
    broadcast: null,
    userIds: [],
  })
})
