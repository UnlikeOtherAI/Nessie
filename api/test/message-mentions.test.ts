import assert from 'node:assert/strict'
import test from 'node:test'

import type { PrismaClient } from '@prisma/client'

import { createThreadMessage } from '../src/services/message-create.js'

// A channel with one bound agent ("Bound"); the org also has a shared agent
// "Scout" that is NOT a member of this channel.
const makePrisma = () => {
  // `messageCreates` is where the mentions must land: the agent-mention merge
  // used to be a second `message.update` after the create transaction had
  // already committed, so a crash between them left a message whose stored
  // mentions omitted every agent mention the client had already been shown.
  const calls = { agentFindManyWhere: [] as unknown[], messageCreates: [] as unknown[] }
  const candidates = [
    { id: 'agent-scout', name: 'Scout', ownerUserId: null, visibility: 'team' },
    { id: 'agent-secret', name: 'Secret', ownerUserId: 'user-2', visibility: 'private' },
  ]
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
      create: async (input: unknown) => {
        calls.messageCreates.push(input)
        return {
          id: 'message-1',
          role: 'user',
          content: '@Scout and @Bound please help',
          metadata: {},
          reactions: [],
          user: { id: 'user-1', displayName: 'User One' },
          agent: null,
        }
      },
      update: async () => {
        throw new Error('message metadata must be written by the create, not a later update')
      },
    },
    agent: {
      findMany: async (args: {
        where: {
          AND?: Array<{
            OR?: Array<{ ownerUserId?: string; visibility?: string }>
          }>
        }
      }) => {
        calls.agentFindManyWhere.push(args.where)
        // Honour the shared visibility fragment: a cast Prisma fake is part of
        // the query contract, so it must not return a private row that the real
        // where-clause would exclude.
        const privateArm = args.where.AND?.[0]?.OR?.find(
          (arm) => arm.visibility === 'private',
        )
        return candidates
          .filter((candidate) =>
            candidate.visibility === 'team'
            || candidate.ownerUserId === privateArm?.ownerUserId)
          .map(({ id, name }) => ({ id, name }))
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

test('a structured mention selects one bound agent when an unbound agent has the same name', async () => {
  const { prisma, calls } = makePrisma()
  const selectedId = '00000000-0000-4000-8000-000000000010'
  const fake = prisma as unknown as {
    agent: { findMany: () => Promise<unknown> }
    thread: { findUnique: () => Promise<unknown> }
  }
  fake.thread.findUnique = async () => ({
    channel: {
      id: 'channel-1',
      agentBindings: [{
        agent: {
          agentKind: 'shared',
          id: selectedId,
          name: 'Web summary',
          role: 'assistant',
          systemPrompt: null,
        },
        principalUserId: null,
      }],
      members: [{ user: { id: 'user-1', displayName: 'User One' } }],
      organizationId: 'org-1',
      systemChannelType: null,
    },
  })
  fake.agent.findMany = async () => {
    throw new Error('an exact bound mention must not scan same-named agents')
  }
  const mention = { agentId: selectedId, type: 'agent' as const }

  const result = await createThreadMessage(prisma, {
    agentMentions: [mention],
    content: '@Web summary are you there?',
    threadId: 'thread-1',
    userId: 'user-1',
  })

  assert.equal(result.kind, 'created')
  if (result.kind !== 'created') return
  assert.deepEqual(result.pendingAgentInvites, [])
  assert.deepEqual(result.channelAgents.map((candidate) => candidate.id), [selectedId])
  const created = calls.messageCreates[0] as {
    data: { metadata: { mentions: unknown } }
  }
  assert.deepEqual(created.data.metadata.mentions, {
    agentIds: [selectedId],
    agentMentions: [mention],
    broadcast: null,
    userIds: [],
  })
})

test('createThreadMessage does not expose a non-owner private agent as a pending invite', async () => {
  const { prisma } = makePrisma()

  const result = await createThreadMessage(prisma, {
    content: '@Secret please help',
    threadId: 'thread-1',
    userId: 'user-1',
  })

  assert.equal(result.kind, 'created')
  if (result.kind !== 'created') return
  assert.deepEqual(result.pendingAgentInvites, [])
})

test('a PA mention is validated by its binding ids and stored as structured metadata', async () => {
  const { prisma, calls } = makePrisma()
  const agentId = '00000000-0000-4000-8000-000000000001'
  const principalUserId = '00000000-0000-4000-8000-000000000002'
  const fake = prisma as unknown as {
    thread: { findUnique: () => Promise<unknown> }
  }
  fake.thread.findUnique = async () => ({
    channel: {
      id: 'channel-1',
      agentBindings: [{
        agent: {
          agentKind: 'personal_assistant',
          id: agentId,
          name: 'Personal Assistant',
          role: 'assistant',
          systemPrompt: null,
        },
        principalUserId,
      }],
      members: [{ user: { id: 'user-1', displayName: 'User One' } }],
      organizationId: 'org-1',
      systemChannelType: null,
    },
  })

  const mention = { agentId, principalUserId, type: 'agent' as const }
  const result = await createThreadMessage(prisma, {
    agentMentions: [mention],
    content: '@Owner – PA please help',
    threadId: 'thread-1',
    userId: 'user-1',
  })

  assert.equal(result.kind, 'created')
  if (result.kind !== 'created') return
  assert.deepEqual(result.agentMentions, [mention])
  assert.deepEqual(result.channelAgents, [{
    id: agentId,
    name: 'Personal Assistant',
    principalUserId,
    role: 'assistant',
    systemPrompt: null,
  }])
  const created = calls.messageCreates[0] as {
    data: { metadata: { mentions: unknown } }
  }
  assert.deepEqual(created.data.metadata.mentions, {
    agentIds: [],
    agentMentions: [mention],
    broadcast: null,
    userIds: [],
  })
})

test('a stale PA mention is rejected before a message is written', async () => {
  const { prisma } = makePrisma()

  const result = await createThreadMessage(prisma, {
    agentMentions: [{
      agentId: '00000000-0000-4000-8000-000000000003',
      principalUserId: '00000000-0000-4000-8000-000000000004',
      type: 'agent',
    }],
    content: '@PA please help',
    threadId: 'thread-1',
    userId: 'user-1',
  })

  assert.deepEqual(result, { kind: 'invalid_agent_mention' })
})
