import assert from 'node:assert/strict'
import test from 'node:test'

import { canManageChannelAgents } from '../src/channel-agent-authority.js'

/**
 * The predicate behind `ChannelRecord.viewerCanManageAgents`.
 *
 * It exists because the client drew the agent Add and Remove controls for
 * everybody while `POST`/`DELETE /api/agents/:agentId/bindings` refused every
 * non-owner. These cases pin the three conjuncts those routes apply, in their
 * order, and in particular that this is NOT `canModifyChannel`: an admin, or
 * an ordinary member of the channel, may rename the room and add people to it
 * and still may not place an agent in it.
 */

const CHANNEL = {
  id: '11111111-1111-4111-8111-111111111111',
  organizationId: '22222222-2222-4222-8222-222222222222',
  systemChannelType: null,
}
const USER = '33333333-3333-4333-8333-333333333333'

const prismaFor = (input: { role?: string | null; memberCount?: number }) => {
  const calls: string[] = []
  return {
    calls,
    prisma: {
      channelMember: {
        count: async () => {
          calls.push('channelMember.count')
          return input.memberCount ?? 1
        },
      },
      organizationMember: {
        findFirst: async () => {
          calls.push('organizationMember.findFirst')
          return input.role === undefined ? null : { role: input.role }
        },
      },
    } as unknown as Parameters<typeof canManageChannelAgents>[0],
  }
}

test('an organisation owner who is in the channel may place an agent', async () => {
  const { prisma } = prismaFor({ role: 'owner' })
  assert.equal(await canManageChannelAgents(prisma, { channel: CHANNEL, userId: USER }), true)
})

test('an admin may not: the binding routes gate on requireOwner, not owner-or-admin', async () => {
  const { prisma } = prismaFor({ role: 'admin' })
  assert.equal(await canManageChannelAgents(prisma, { channel: CHANNEL, userId: USER }), false)
})

test('an ordinary member may not, however much of the channel they can otherwise manage', async () => {
  const { prisma } = prismaFor({ role: 'member' })
  assert.equal(await canManageChannelAgents(prisma, { channel: CHANNEL, userId: USER }), false)
})

test('an owner who has not joined the channel may not: the routes resolve it through getChannelIfMember', async () => {
  const { prisma } = prismaFor({ role: 'owner', memberCount: 0 })
  assert.equal(await canManageChannelAgents(prisma, { channel: CHANNEL, userId: USER }), false)
})

test('no system conversation admits a second agent, whoever is asking', async () => {
  const { calls, prisma } = prismaFor({ role: 'owner' })
  for (const systemChannelType of ['personal_assistant', 'system_agent', 'agent_email']) {
    assert.equal(
      await canManageChannelAgents(prisma, {
        channel: { ...CHANNEL, systemChannelType },
        userId: USER,
      }),
      false,
    )
  }
  // Refused before either lookup: the surface decides it, not the person.
  assert.deepEqual(calls, [])
})

test('a caller that already knows the two facts costs no query', async () => {
  const { calls, prisma } = prismaFor({ role: 'owner' })
  assert.equal(
    await canManageChannelAgents(prisma, {
      channel: CHANNEL,
      isChannelMember: true,
      isOrganizationOwner: true,
      userId: USER,
    }),
    true,
  )
  assert.deepEqual(calls, [])

  // …and a passed `false` is believed rather than re-read.
  assert.equal(
    await canManageChannelAgents(prisma, {
      channel: CHANNEL,
      isOrganizationOwner: false,
      userId: USER,
    }),
    false,
  )
  assert.deepEqual(calls, [])
})
