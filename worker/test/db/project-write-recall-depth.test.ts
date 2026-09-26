import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

import { PrismaClient } from '@prisma/client'
import { EMBEDDING_DIMENSIONS } from '@nessie/schemas'
import { Pool } from 'pg'

import { createConsumedSourceSink } from '../../src/run/execute/disclosure-basis.js'
import { retrieveRelevantHistory } from '../../src/run/execute/history-recall.js'
import { retrieveRelevantMemories } from '../../src/run/execute/memory.js'
import { runDatabaseTest } from './support.js'

/**
 * F16 follow-up: recall containment must not make recall come back short.
 *
 * A contained run judges each recalled item's whole lineage after the search —
 * against the project-write floor when it was lent a project write, otherwise
 * against what its room already implies. When the search asked for only the
 * normal count, a requester whose best matches all came from their private DM
 * (or a private room) got nothing back, although material the destination may
 * carry sat just below the cut. These seed more private hits than the normal
 * count, all ranked above a few project-lineage ones, and run the real recall
 * against the real ranking functions.
 */

const MEMORY_LIMIT = 5
const HISTORY_CANDIDATES = 12
const DAY_MS = 86_400_000

const vector = (): number[] => [1, ...Array<number>(EMBEDDING_DIMENSIONS - 1).fill(0)]

type Seed = {
  agentId: string
  boardRoomId: string
  cleanThoughts: string[]
  dmId: string
  dmLineageMessages: string[]
  dmThoughts: string[]
  leadershipId: string
  leadershipMessages: string[]
  organizationId: string
  projectId: string
  publicMessages: string[]
  requesterId: string
  teamId: string
}

type Counts = {
  cleanHits: number
  /** Public-room messages that carry the requester's DM as their source. */
  dmLineageHits?: number
  privateHits: number
}

const seed = async (
  prisma: PrismaClient,
  pool: Pool,
  suffix: string,
  counts: Counts,
): Promise<Seed> => {
  const requester = await prisma.user.create({
    data: { displayName: 'Requester', email: `depth-requester-${suffix}@example.test` },
  })
  const organization = await prisma.organization.create({ data: { name: `depth-${suffix}` } })
  await prisma.organizationMember.create({
    data: { organizationId: organization.id, role: 'member', userId: requester.id },
  })
  const project = await prisma.project.create({
    data: { name: `depth-project-${suffix}`, organizationId: organization.id },
  })
  await prisma.projectMember.create({ data: { projectId: project.id, userId: requester.id } })
  const team = await prisma.team.create({ data: { name: `depth-team-${suffix}`, projectId: project.id } })
  const channel = (label: string, extra: Record<string, unknown>) => prisma.channel.create({
    data: {
      label,
      organizationId: organization.id,
      projectId: project.id,
      slug: `${label}-${suffix.slice(0, 8)}`,
      teamId: team.id,
      ...extra,
    },
  })
  const boardRoom = await channel('board-room', { type: 'standard', visibility: 'public' })
  const dm = await channel('assistant', {
    systemChannelType: 'personal_assistant',
    type: 'dm',
    visibility: 'private',
  })
  const leadership = await channel('leadership', { type: 'standard', visibility: 'private' })
  await prisma.channelMember.createMany({
    data: [boardRoom, dm, leadership].map(({ id }) => ({ channelId: id, userId: requester.id })),
  })
  const agent = await prisma.agent.create({
    data: { name: 'CTO', organizationId: organization.id, toolPolicy: { ticket_create: true } },
  })
  await prisma.agentBinding.createMany({
    data: [boardRoom, leadership].map(({ id }) => ({ agentId: agent.id, channelId: id })),
  })

  // Every thought has the query's own embedding and one match for its word,
  // so both ranking arms order them by `created_at`: the DM-fed ones are the
  // newest and outrank every clean one.
  const insertThought = (
    id: string,
    content: string,
    audience: { id: string; type: 'organization' | 'project' },
    createdAt: Date,
  ) => pool.query(
    `INSERT INTO thoughts (
       id, content, content_hash, embedding, owner_id, owner_type,
       audience_type, audience_id, organization_id, project_id, visibility,
       sensitivity_tier, importance, metadata, embedding_model, dims, created_at, updated_at
     ) VALUES (
       $1, $2, $3, $4::vector, $5, 'service', $6::text::"ThoughtAudienceType", $7, $8, $9,
       $6::text::"ThoughtVisibility", 'normal', 0.9, '{}'::jsonb, 'test-embedding', $10, $11, $11
     )`,
    [
      id, content, `hash-${id}`, `[${vector().join(',')}]`, agent.id, audience.type, audience.id,
      organization.id, audience.type === 'project' ? project.id : null, EMBEDDING_DIMENSIONS, createdAt,
    ],
  )
  const now = Date.now()
  const dmThoughts = Array.from({ length: counts.privateHits }, () => randomUUID())
  for (const [index, id] of dmThoughts.entries()) {
    await insertThought(
      id,
      `The requester privately noted webhook idea ${index + 1}.`,
      { id: organization.id, type: 'organization' },
      new Date(now - index * 1_000),
    )
    await pool.query(
      `INSERT INTO thought_disclosure_sources (
         id, thought_id, organization_id, source_channel_id, source_author_user_id, created_at
       ) VALUES (gen_random_uuid(), $1, $2, $3, $4, now())`,
      [id, organization.id, dm.id, requester.id],
    )
  }
  // The clean ones alternate between the two audiences a project write
  // implies: the organisation and the project itself.
  const cleanThoughts = Array.from({ length: counts.cleanHits }, () => randomUUID())
  for (const [index, id] of cleanThoughts.entries()) {
    await insertThought(
      id,
      `Project knowledge about webhook retries, note ${index + 1}.`,
      index % 2 === 0
        ? { id: organization.id, type: 'organization' }
        : { id: project.id, type: 'project' },
      new Date(now - 30 * DAY_MS - index * 1_000),
    )
  }

  // Conversation history: more private-room passages than the normal
  // candidate depth, each saying the word more often than any public one, so
  // the lexical arm ranks every one of them first.
  const leadershipThread = await prisma.thread.create({ data: { channelId: leadership.id, title: 'main' } })
  const leadershipMessages: string[] = []
  for (let index = 0; index < counts.privateHits * 2; index += 1) {
    const created = await prisma.message.create({
      data: {
        content: `Webhook webhook webhook freeze, private note ${index + 1}.`,
        role: 'user',
        threadId: leadershipThread.id,
        userId: requester.id,
      },
    })
    leadershipMessages.push(created.id)
  }
  const publicMessages: string[] = []
  for (let index = 0; index < counts.cleanHits; index += 1) {
    const thread = await prisma.thread.create({ data: { channelId: boardRoom.id, title: `t${index}` } })
    const created = await prisma.message.create({
      data: {
        content: `Webhook retries are tracked on the board, item ${index + 1}.`,
        role: 'user',
        threadId: thread.id,
        userId: requester.id,
      },
    })
    publicMessages.push(created.id)
  }
  // Public-room messages relaying what the requester said in their DM: the
  // room is public and nothing in their basis is out of reach, so only their
  // DM source is what a project write refuses. Each says the word more often
  // than any clean one, in a thread of its own.
  const dmLineageMessages: string[] = []
  for (let index = 0; index < (counts.dmLineageHits ?? 0); index += 1) {
    const thread = await prisma.thread.create({ data: { channelId: boardRoom.id, title: `relay${index}` } })
    const created = await prisma.message.create({
      data: {
        content: `Webhook webhook webhook freeze, relayed from the assistant chat, note ${index + 1}.`,
        disclosureSources: {
          create: { organizationId: organization.id, sourceAuthorUserId: requester.id, sourceChannelId: dm.id },
        },
        role: 'assistant',
        agentId: agent.id,
        threadId: thread.id,
      },
    })
    dmLineageMessages.push(created.id)
  }

  return {
    agentId: agent.id,
    boardRoomId: boardRoom.id,
    cleanThoughts,
    dmId: dm.id,
    dmLineageMessages,
    dmThoughts,
    leadershipId: leadership.id,
    leadershipMessages,
    organizationId: organization.id,
    projectId: project.id,
    publicMessages,
    requesterId: requester.id,
    teamId: team.id,
  }
}

const deps = (prisma: PrismaClient, pool: Pool) => ({
  modelClient: {
    embedMany: async (texts: string[]) => texts.map(() => vector()),
    embeddingModel: 'test-embedding',
  },
  prisma,
  searchConfig: { modelClient: { embed: async () => vector() }, pool },
}) as never

const runContext = (s: Seed, sink = createConsumedSourceSink()) => ({
  agent: { agentKind: 'shared', id: s.agentId, systemSlug: null },
  boundAgentIds: [s.agentId],
  channel: {
    dmKey: null,
    id: s.boardRoomId,
    organizationId: s.organizationId,
    projectId: s.projectId,
    systemChannelType: null,
    teamId: s.teamId,
  },
  consumedSources: sink,
  run: { id: randomUUID(), threadId: randomUUID() },
  task: { id: randomUUID() },
}) as never

const payload = (s: Seed) => ({
  actorContext: {
    actionContext: { effectiveUserId: s.requesterId, requestId: randomUUID() },
    actor: { actorId: s.requesterId, actorType: 'user', roles: ['member'] },
    tenant: { organizationId: s.organizationId },
  },
}) as never

const entitlements = (s: Seed) => ({
  kind: 'local' as const,
  organizationId: s.organizationId,
  userId: s.requesterId,
})

const recallMemories = (
  prisma: PrismaClient,
  pool: Pool,
  s: Seed,
  holdsProjectWriteTools: boolean,
  sink = createConsumedSourceSink(),
) =>
  retrieveRelevantMemories(
    deps(prisma, pool),
    runContext(s, sink),
    payload(s),
    'webhook',
    entitlements(s),
    { holdsProjectWriteTools },
  )

const recallHistory = (
  prisma: PrismaClient,
  pool: Pool,
  s: Seed,
  holdsProjectWriteTools: boolean,
  sink = createConsumedSourceSink(),
) =>
  retrieveRelevantHistory(deps(prisma, pool), runContext(s, sink), payload(s), {
    holdsProjectWriteTools,
    liveEntitlements: entitlements(s),
    prompt: 'webhook',
    viewer: {
      kind: 'user',
      scopes: [
        { scopeId: s.organizationId, scopeType: 'organization' },
        { scopeId: s.projectId, scopeType: 'project' },
        { scopeId: s.teamId, scopeType: 'team' },
        { scopeId: s.boardRoomId, scopeType: 'channel' },
        { scopeId: s.leadershipId, scopeType: 'channel' },
      ],
      userId: s.requesterId,
    },
  })

// Records the candidate search's per-arm limit (its tenth parameter) from the
// real query, so a test can pin the depth a recall searched at.
const spyOnCandidateDepth = (pool: Pool, depths: unknown[]): Pool => ({
  connect: () => pool.connect(),
  query: (sql: string, params?: unknown[]) => {
    if (sql.includes('lexical AS')) depths.push(params?.[9])
    return pool.query(sql, params)
  },
}) as unknown as Pool

const withSeed = async (
  t: { after: (fn: () => Promise<void>) => void },
  counts: Counts,
  run: (prisma: PrismaClient, pool: Pool, s: Seed) => Promise<void>,
): Promise<void> => {
  const prisma = new PrismaClient()
  const pool = new Pool({ connectionString: process.env.DATABASE_URL })
  const suffix = randomUUID()
  t.after(async () => {
    await prisma.organization.deleteMany({ where: { name: `depth-${suffix}` } })
    await prisma.user.deleteMany({ where: { email: { contains: suffix } } })
    await pool.end()
    await prisma.$disconnect()
  })
  await run(prisma, pool, await seed(prisma, pool, suffix, counts))
}

// Seven DM-fed memories outrank three clean ones; history holds fourteen
// private-room passages above three public ones.
const FEW_CLEAN = { cleanHits: 3, privateHits: MEMORY_LIMIT + 2 }

runDatabaseTest('a run lent a project write still recalls the project memories below the DM hits', async (t) => {
  await withSeed(t, FEW_CLEAN, async (prisma, pool, s) => {
    const sink = createConsumedSourceSink()
    const memories = await recallMemories(prisma, pool, s, true, sink)
    assert.deepEqual(memories.map(({ id }) => id), s.cleanThoughts)
    // Only what they brought enters the basis: the organisation and the
    // project, never the DM the deeper search also passed over.
    assert.deepEqual(
      [...sink.list()].sort((left, right) => left.scopeType.localeCompare(right.scopeType)),
      [
        { scopeId: s.organizationId, scopeType: 'organization' },
        { scopeId: s.projectId, scopeType: 'project' },
      ],
    )
    assert.deepEqual(sink.privateConversationSources(), [])
  })
})

// A room run without write tools used to take the five DM-fed memories and
// post a reply only the requester could read. Recall may not be what restricts
// a reply in its own room, so it too searches deeper for what the room may read.
runDatabaseTest('a room run without write tools recalls the room-readable memories below the DM hits', async (t) => {
  await withSeed(t, FEW_CLEAN, async (prisma, pool, s) => {
    const sink = createConsumedSourceSink()
    const memories = await recallMemories(prisma, pool, s, false, sink)
    assert.deepEqual(memories.map(({ id }) => id), s.cleanThoughts)
    assert.deepEqual(sink.privateConversationSources(), [], 'the DM never enters the basis')
  })
})

const accessOf = async (pool: Pool, ids: string[]) => {
  const { rows } = await pool.query<{ access_count: number; id: string; last_accessed_at: Date | null }>(
    'SELECT id, access_count, last_accessed_at FROM thoughts WHERE id = ANY($1::uuid[])',
    [ids],
  )
  return new Map(rows.map((row) => [row.id, { count: row.access_count, at: row.last_accessed_at?.getTime() ?? null }]))
}

const recalledThoughtIds = async (pool: Pool, ids: string[]): Promise<string[]> => {
  const { rows } = await pool.query<{ thought_id: string }>(
    'SELECT thought_id FROM thought_recalls WHERE thought_id = ANY($1::uuid[])',
    [ids],
  )
  return rows.map((row) => row.thought_id).sort()
}

// The deeper search ranks the DM-fed thoughts too. Access feeds the recency
// term of every later ranking, so refreshing the ones it refused would lift
// exactly those above the project knowledge the next recall came for.
runDatabaseTest('a project-write recall refreshes and logs only the thoughts it keeps', async (t) => {
  await withSeed(t, FEW_CLEAN, async (prisma, pool, s) => {
    const every = [...s.dmThoughts, ...s.cleanThoughts]
    const before = await accessOf(pool, every)

    const memories = await recallMemories(prisma, pool, s, true)
    assert.deepEqual(memories.map(({ id }) => id), s.cleanThoughts)

    const after = await accessOf(pool, every)
    for (const id of s.dmThoughts) {
      assert.deepEqual(after.get(id), before.get(id), 'a refused DM-fed thought is not marked accessed')
    }
    for (const id of s.cleanThoughts) {
      assert.equal(after.get(id)?.count, (before.get(id)?.count ?? 0) + 1, 'a kept thought is')
    }
    assert.deepEqual(await recalledThoughtIds(pool, every), [...s.cleanThoughts].sort())
  })
})

runDatabaseTest('a project-write recall never returns more than the normal count', async (t) => {
  await withSeed(t, { cleanHits: MEMORY_LIMIT + 2, privateHits: MEMORY_LIMIT + 2 }, async (prisma, pool, s) => {
    const memories = await recallMemories(prisma, pool, s, true)
    assert.deepEqual(memories.map(({ id }) => id), s.cleanThoughts.slice(0, MEMORY_LIMIT))
    // The clean ones below the cut were passed over too, so they are not
    // logged as recalled either.
    assert.deepEqual(
      await recalledThoughtIds(pool, [...s.dmThoughts, ...s.cleanThoughts]),
      s.cleanThoughts.slice(0, MEMORY_LIMIT).sort(),
    )
  })
})

runDatabaseTest('a run lent a project write still recalls public history below the private-room hits', async (t) => {
  await withSeed(t, FEW_CLEAN, async (prisma, pool, s) => {
    assert.ok(s.leadershipMessages.length > HISTORY_CANDIDATES)
    const sink = createConsumedSourceSink()
    const history = await recallHistory(prisma, pool, s, true, sink)
    assert.deepEqual([...history.messageIds].sort(), [...s.publicMessages].sort())
    assert.deepEqual(sink.list(), [])
    assert.deepEqual(sink.privateConversationSources(), [])
  })
})

runDatabaseTest('a room run without write tools recalls public history below the private-room hits', async (t) => {
  await withSeed(t, FEW_CLEAN, async (prisma, pool, s) => {
    const sink = createConsumedSourceSink()
    const depths: unknown[] = []
    const history = await recallHistory(prisma, spyOnCandidateDepth(pool, depths), s, false, sink)
    // The deeper search, measured on the real query: each ranking arm's limit
    // is four times it.
    assert.deepEqual(depths, [HISTORY_CANDIDATES * 3 * 4])
    // The requester may read the private room, but its passages would have
    // restricted the reply in this public one.
    assert.deepEqual([...history.messageIds].sort(), [...s.publicMessages].sort())
    assert.deepEqual(sink.list(), [])
    assert.deepEqual(sink.privateConversationSources(), [])
  })
})

// History's own DM lineage: public-room messages relaying what the requester
// said in their DM, more of them than the normal candidate depth and every one
// ranked above the clean ones. Nothing but that source is out of reach, so this
// is the lineage filter alone at work under the deeper search.
const DM_RELAYED = { cleanHits: 3, dmLineageHits: HISTORY_CANDIDATES + 2, privateHits: 0 }

runDatabaseTest('a run lent a project write recalls public history below the DM-relayed hits', async (t) => {
  await withSeed(t, DM_RELAYED, async (prisma, pool, s) => {
    const sink = createConsumedSourceSink()
    const depths: unknown[] = []
    const history = await recallHistory(prisma, spyOnCandidateDepth(pool, depths), s, true, sink)
    assert.deepEqual(depths, [HISTORY_CANDIDATES * 3 * 4])
    assert.deepEqual([...history.messageIds].sort(), [...s.publicMessages].sort())
    assert.deepEqual(sink.list(), [])
    assert.deepEqual(sink.privateConversationSources(), [], 'the DM never enters the basis')
  })
})

runDatabaseTest('a room run without write tools recalls none of the DM-relayed history either', async (t) => {
  await withSeed(t, DM_RELAYED, async (prisma, pool, s) => {
    const sink = createConsumedSourceSink()
    const history = await recallHistory(prisma, pool, s, false, sink)
    assert.deepEqual([...history.messageIds].sort(), [...s.publicMessages].sort())
    assert.deepEqual(sink.privateConversationSources(), [], 'the DM never enters the basis')
  })
})
