import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'

import { EMBEDDING_DIMENSIONS } from '@nessie/schemas'

import { startRoomHarness, type Room, type RoomHarness } from './room-run-harness.js'
import { runDatabaseTest } from './support.js'

// A scheduled post into a public room, end to end through the real trigger
// fire and run executor, with only inference pointed at the mock provider.
//
// Seen live: a "Morning Joke" agent's daily joke in #random recalled its
// owner's DM with the agent — the schedule reads as its owner — and every joke
// was withheld from everyone else in the room, with a card telling the owner
// its sources were private. Deleting the DM would not have helped: each joke
// inherited the stamp from the one before it through the room's own history.
// docs/standards/disclosure-boundaries.md → "Assembled context never restricts
// a reply".

const DM_TEXT = 'Try one on me first: tell me a joke about my divorce lawyer.'
const STAMPED_JOKE = 'What do you call a fake noodle? An impasta.'

// The owner tried the agent out in its DM before scheduling it, and that
// conversation is indexed like any other.
const seedOwnerDm = async (harness: RoomHarness, room: Room): Promise<string> => {
  const { prisma } = harness
  const { ensureSharedAgentDm } = await import('@nessie/team-admin')
  const dmId = await ensureSharedAgentDm(prisma, {
    agentId: room.agentId,
    agentName: 'Morning Joke',
    organizationId: room.organizationId,
    projectId: room.projectId,
    teamId: room.teamId,
    userId: room.ownerId,
  })
  const dmThread = await prisma.thread.create({ data: { agentId: room.agentId, channelId: dmId } })
  const dmTurns = [
    await prisma.message.create({
      data: { content: DM_TEXT, role: 'user', threadId: dmThread.id, userId: room.ownerId },
    }),
    await prisma.message.create({
      data: {
        agentId: room.agentId,
        content: 'Your lawyer bills by the hour, so this one is free.',
        role: 'assistant',
        threadId: dmThread.id,
      },
    }),
  ]
  // The mock provider embeds every text alike, so these are the query's
  // nearest neighbours.
  const vector = `[${[1, ...Array<number>(EMBEDDING_DIMENSIONS - 1).fill(0)].join(',')}]`
  for (const turn of dmTurns) {
    await harness.pool.query(
      `INSERT INTO message_embeddings (id, message_id, content_hash, embedding, embedding_model, dims, status, created_at, updated_at)
       VALUES (gen_random_uuid(), $1, $2, $3::vector, $4, $5, 'indexed', now(), now())`,
      [
        turn.id,
        createHash('sha256').update(turn.content, 'utf8').digest('hex'),
        vector,
        harness.embeddingModel,
        EMBEDDING_DIMENSIONS,
      ],
    )
  }
  return dmId
}

runDatabaseTest('a scheduled post into a public room', async (t) => {
  const harness = await startRoomHarness()
  t.after(harness.close)
  const { fire, ask, readableBy } = harness

  type Fixture = Room & { colleagueId: string; dmId: string }
  const withFixture = async (
    st: { after: (fn: () => Promise<void>) => void },
    body: (s: Fixture) => Promise<void>,
  ): Promise<void> => {
    const room = await harness.seedRoom(st, ['Ondrej', 'Colleague'])
    const dmId = await seedOwnerDm(harness, room)
    await body({ ...room, colleagueId: room.people['Colleague']!, dmId })
  }

  // A post the room already holds, stamped from the owner's DM the way every
  // joke was before this fix.
  const seedStampedPost = (s: Fixture) => harness.prisma.message.create({
    data: {
      agentId: s.agentId,
      basisScopes: { create: { organizationId: s.organizationId, scopeId: s.dmId, scopeType: 'channel' } },
      content: STAMPED_JOKE,
      disclosureSources: {
        create: { organizationId: s.organizationId, sourceAuthorUserId: s.ownerId, sourceChannelId: s.dmId },
      },
      role: 'assistant',
      threadId: s.roomThreadId,
    },
  })

  await t.test('recalls none of its owner\'s DM with the agent, and the whole room reads it', async (st) => {
    await withFixture(st, async (s) => {
      const { posted, sent } = await fire(s, 'Why did the math book look sad? It had too many problems.')
      assert.ok(!sent.includes(DM_TEXT), 'the owner\'s DM never reaches the model')
      assert.deepEqual(posted.basisScopes, [])
      assert.deepEqual(posted.disclosureSources, [])
      assert.equal(await readableBy(s, s.colleagueId, posted), true)
    })
  })

  await t.test('one restricted post no longer keeps the next one restricted', async (st) => {
    await withFixture(st, async (s) => {
      await seedStampedPost(s)
      const { posted, sent } = await fire(s, 'Why don\'t scientists trust atoms? Because they make up everything.')
      assert.ok(!sent.includes(STAMPED_JOKE), 'the room\'s restricted post is withheld from the schedule')
      assert.deepEqual(posted.basisScopes, [])
      assert.equal(await readableBy(s, s.colleagueId, posted), true)
    })
  })

  await t.test('its owner\'s live turn still continues the restricted post, restricted', async (st) => {
    await withFixture(st, async (s) => {
      await seedStampedPost(s)
      const { posted, sent } = await ask(s, {
        asUserId: s.ownerId,
        question: 'Explain that one?',
        text: 'It is a pun on imposter.',
      })
      assert.ok(sent.includes(STAMPED_JOKE), 'a live requester keeps the history they may read')
      assert.deepEqual(posted.basisScopes.map(({ scopeId, scopeType }) => ({ scopeId, scopeType })), [
        { scopeId: s.dmId, scopeType: 'channel' },
      ])
      assert.equal(await readableBy(s, s.ownerId, posted), true)
      assert.equal(await readableBy(s, s.colleagueId, posted), false)
    })
  })
})
