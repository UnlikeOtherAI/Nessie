import assert from 'node:assert/strict'
import test from 'node:test'

import { canManageChannelAgents } from '../src/channel-agent-authority.js'

/**
 * The predicate behind `ChannelRecord.viewerCanManageAgents`.
 *
 * It exists because the client drew the agent Add and Remove controls for
 * everybody while `POST`/`DELETE /api/agents/:agentId/bindings` refused every
 * caller the routes' gate did not admit. These cases pin the two conjuncts
 * those routes apply, in their order, and in particular that this is NOT
 * `canModifyChannel`: an ordinary member of the channel may rename the room and
 * add people to it and still may not place an agent in it, while an
 * organisation admin may place one in a room they never joined.
 *
 * The membership conjunct the routes used to apply is deliberately gone —
 * management is not participation (`docs/standards/team-model.md`) — so these
 * cases also pin that no `channelMember` lookup happens at all. A prisma stub
 * carrying only `organizationMember` would throw if one were reintroduced.
 */

const CHANNEL = {
  organizationId: '22222222-2222-4222-8222-222222222222',
  systemChannelType: null,
  type: 'standard',
}
const USER = '33333333-3333-4333-8333-333333333333'

const prismaFor = (input: { role?: string | null }) => {
  const calls: string[] = []
  return {
    calls,
    prisma: {
      organizationMember: {
        findFirst: async () => {
          calls.push('organizationMember.findFirst')
          return input.role === undefined ? null : { role: input.role }
        },
      },
    } as unknown as Parameters<typeof canManageChannelAgents>[0],
  }
}

test('an organisation owner may place an agent', async () => {
  const { prisma } = prismaFor({ role: 'owner' })
  assert.equal(await canManageChannelAgents(prisma, { channel: CHANNEL, userId: USER }), true)
})

test('an organisation admin may too: the binding routes gate on owner-or-admin', async () => {
  const { prisma } = prismaFor({ role: 'admin' })
  assert.equal(await canManageChannelAgents(prisma, { channel: CHANNEL, userId: USER }), true)
})

test('an ordinary member may not, however much of the channel they can otherwise manage', async () => {
  const { prisma } = prismaFor({ role: 'member' })
  assert.equal(await canManageChannelAgents(prisma, { channel: CHANNEL, userId: USER }), false)
})

test('somebody with no organisation membership at all may not', async () => {
  const { prisma } = prismaFor({})
  assert.equal(await canManageChannelAgents(prisma, { channel: CHANNEL, userId: USER }), false)
})

/**
 * The case this whole change turns on. Before it, the predicate ANDed a live
 * `ChannelMember` row onto the role, so an admin administering a room they had
 * not joined saw no control while the route would have accepted them — and
 * adding one had to make them a member first, which decision 1 forbids.
 */
test('an admin who never joined the channel may still place an agent, and no membership is read', async () => {
  const { calls, prisma } = prismaFor({ role: 'admin' })
  assert.equal(await canManageChannelAgents(prisma, { channel: CHANNEL, userId: USER }), true)
  assert.deepEqual(calls, ['organizationMember.findFirst'])
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
  // Refused before the role lookup: the surface decides it, not the person.
  assert.deepEqual(calls, [])
})

/**
 * A direct message — one-to-one or group — is somebody's private conversation.
 * No organisation role reaches into one, so an admin may not place an agent in
 * a DM even though `systemChannelType` is null and they administer the org.
 */
test('a direct message admits no agent placement by an organisation admin', async () => {
  const { calls, prisma } = prismaFor({ role: 'admin' })
  assert.equal(
    await canManageChannelAgents(prisma, {
      channel: { ...CHANNEL, type: 'dm' },
      userId: USER,
    }),
    false,
  )
  assert.deepEqual(calls, [])
})

test('a caller that already knows the role costs no query', async () => {
  const { calls, prisma } = prismaFor({ role: 'owner' })
  assert.equal(
    await canManageChannelAgents(prisma, {
      channel: CHANNEL,
      isOrganizationAdmin: true,
      userId: USER,
    }),
    true,
  )
  assert.deepEqual(calls, [])

  // …and a passed `false` is believed rather than re-read.
  assert.equal(
    await canManageChannelAgents(prisma, {
      channel: CHANNEL,
      isOrganizationAdmin: false,
      userId: USER,
    }),
    false,
  )
  assert.deepEqual(calls, [])
})
