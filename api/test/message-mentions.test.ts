import assert from 'node:assert/strict'
import test from 'node:test'

import type { PrismaClient } from '@prisma/client'

import { createThreadMessage } from '../src/services/messages.js'

// A channel with one bound agent ("Bound"); the org also has a shared agent
// "Scout" that is NOT a member of this channel.
const makePrisma = () => {
  const calls = { agentFindManyWhere: [] as unknown[] }
  const prisma = {
    thread: {
      findUnique: async () => ({
        channel: {
          id: 'channel-1',
          agentBindings: [
            {
              agent: {
                id: 'agent-bound',
                name: 'Bound',
                role: 'assistant',
                systemPrompt: null,
              },
            },
          ],
          members: [
            { user: { id: 'user-1', displayName: 'User One' } },
          ],
          organizationId: 'org-1',
          systemChannelType: null,
        },
      }),
    },
    message: {
      create: async () => ({
        id: 'message-1',
        role: 'user',
        content: '@Scout and @Bound please help',
        metadata: {},
        reactions: [],
        user: { id: 'user-1', displayName: 'User One' },
        agent: null,
      }),
      update: async () => ({
        id: 'message-1',
        role: 'user',
        content: '@Scout and @Bound please help',
        metadata: {},
        reactions: [],
        user: { id: 'user-1', displayName: 'User One' },
        agent: null,
      }),
    },
    agent: {
      findMany: async (args: { where: unknown }) => {
        calls.agentFindManyWhere.push(args.where)
        // Candidate non-bound shared agents in the org.
        return [{ id: 'agent-scout', name: 'Scout' }]
      },
    },
    userAlert: {
      createMany: async ({ data }: { data: unknown[] }) => ({ count: data.length }),
    },
    messageThreadFollow: {
      createMany: async () => ({ count: 0 }),
    },
    $transaction: async (callback: (tx: unknown) => Promise<unknown>) => callback(prisma),
  } as unknown as PrismaClient
  return { prisma, calls }
}

test('createThreadMessage dispatches only bound agents and lists non-members as pending invites', async () => {
  const { prisma } = makePrisma()

  const result = await createThreadMessage(prisma, {
    content: '@Scout and @Bound please help',
    threadId: 'thread-1',
    userId: 'user-1',
  })

  assert.equal(result.kind, 'created')
  if (result.kind !== 'created') {
    return
  }

  // Only the channel-bound agent is dispatched.
  assert.deepEqual(
    result.channelAgents.map((a) => a.id),
    ['agent-bound'],
  )

  // The @mentioned non-member agent is surfaced for invitation, not dispatched.
  assert.deepEqual(result.pendingAgentInvites, [{ id: 'agent-scout', name: 'Scout' }])
  assert.ok(!result.channelAgents.some((a) => a.id === 'agent-scout'))
})

test('createThreadMessage returns no pending invites when no unbound agent is mentioned', async () => {
  const { prisma } = makePrisma()

  const result = await createThreadMessage(prisma, {
    content: 'just talking to @Bound here',
    threadId: 'thread-1',
    userId: 'user-1',
  })

  assert.equal(result.kind, 'created')
  if (result.kind !== 'created') {
    return
  }
  assert.deepEqual(result.pendingAgentInvites, [])
})
