import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

import { PrismaClient } from '@prisma/client'
import { EMBEDDING_DIMENSIONS } from '@nessie/schemas'
import { Pool } from 'pg'

import { createConsumedSourceSink, type ConsumedSourceSink } from '../../src/run/execute/disclosure-basis.js'
import { retrieveRelevantMemories } from '../../src/run/execute/memory.js'
import { runChannelListTool } from '../../src/run/pa-tools/channels.js'
import { runTeamSearchTool } from '../../src/run/pa-tools/conversation-search.js'
import { runTicketCreateTool } from '../../src/run/pa-tools/tickets.js'
import type { BuiltinToolRuntimeContext } from '../../src/run/tool-types.js'
import { runDatabaseTest } from './support.js'

/**
 * F16: what a project-channel agent consumed before it acted must not shut its
 * own ticket writes, and nothing it consumes from a private room may reach the
 * board.
 *
 * Seen live: a CTO agent recalled memories captured from its requester's
 * private DMs at run start, each DM entered the run's basis, and the project
 * write gate refused every `ticket_create` from then on. `channel_list` did the
 * same by stamping every DM it merely listed. These run the real recall, the
 * real directory read, a real content read and the real write gate against one
 * seeded organisation.
 */

const REFUSAL = 'I cannot copy restricted research into this shared project.'

const vector = (): number[] => [1, ...Array<number>(EMBEDDING_DIMENSIONS - 1).fill(0)]

type Seed = {
  agentId: string
  dmId: string
  leadershipId: string
  organizationId: string
  projectChannelId: string
  projectId: string
  requesterId: string
  teamId: string
  thoughts: { clean: string; fromDm: string }
}

const seed = async (prisma: PrismaClient, pool: Pool, suffix: string): Promise<Seed> => {
  const requester = await prisma.user.create({
    data: { displayName: 'Requester', email: `recall-requester-${suffix}@example.test` },
  })
  const organization = await prisma.organization.create({ data: { name: `recall-${suffix}` } })
  await prisma.organizationMember.create({
    data: { organizationId: organization.id, role: 'member', userId: requester.id },
  })
  const project = await prisma.project.create({
    data: { name: `recall-project-${suffix}`, organizationId: organization.id },
  })
  await prisma.projectMember.create({ data: { projectId: project.id, userId: requester.id } })
  const team = await prisma.team.create({ data: { name: `recall-team-${suffix}`, projectId: project.id } })
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
  const projectChannel = await channel('board-room', { type: 'standard', visibility: 'public' })
  const dm = await channel('assistant', {
    systemChannelType: 'personal_assistant',
    type: 'dm',
    visibility: 'private',
  })
  const leadership = await channel('leadership', { type: 'standard', visibility: 'private' })
  await prisma.channelMember.createMany({
    data: [projectChannel, dm, leadership].map(({ id }) => ({ channelId: id, userId: requester.id })),
  })

  const agent = await prisma.agent.create({
    data: {
      name: 'CTO',
      organizationId: organization.id,
      toolPolicy: { ticket_create: true, ticket_list: true },
    },
  })
  await prisma.agentBinding.createMany({
    data: [projectChannel, leadership].map(({ id }) => ({ agentId: agent.id, channelId: id })),
  })
  await prisma.board.create({
    data: { isDefault: true, name: 'Board', organizationId: organization.id, position: 0, projectId: project.id },
  })

  // A private room the agent is bound to, holding real content a search reads.
  const leadershipThread = await prisma.thread.create({ data: { channelId: leadership.id, title: 'main' } })
  await prisma.message.create({
    data: {
      content: 'Webhook budget freeze until the audit closes.',
      role: 'user',
      threadId: leadershipThread.id,
      userId: requester.id,
    },
  })

  // Two organisation-audience memories. The second was captured from the
  // requester's private DM, which its lineage keeps.
  const thoughts = { clean: randomUUID(), fromDm: randomUUID() }
  const insertThought = (id: string, content: string) => pool.query(
    `INSERT INTO thoughts (
       id, content, content_hash, embedding, owner_id, owner_type,
       audience_type, audience_id, organization_id, visibility, sensitivity_tier,
       importance, metadata, embedding_model, dims, created_at, updated_at
     ) VALUES (
       $1, $2, $3, $4::vector, $5, 'service', 'organization', $6, $6,
       'organization', 'normal', 0.9, '{}'::jsonb, 'test-embedding', $7, now(), now()
     )`,
    [id, content, `hash-${id}`, `[${vector().join(',')}]`, agent.id, organization.id, EMBEDDING_DIMENSIONS],
  )
  await insertThought(thoughts.clean, 'Webhook retries back off for five attempts.')
  await insertThought(thoughts.fromDm, 'The requester privately plans to rewrite the webhook service.')
  await pool.query(
    `INSERT INTO thought_disclosure_sources (
       id, thought_id, organization_id, source_channel_id, source_author_user_id, created_at
     ) VALUES (gen_random_uuid(), $1, $2, $3, $4, now())`,
    [thoughts.fromDm, organization.id, dm.id, requester.id],
  )

  return {
    agentId: agent.id,
    dmId: dm.id,
    leadershipId: leadership.id,
    organizationId: organization.id,
    projectChannelId: projectChannel.id,
    projectId: project.id,
    requesterId: requester.id,
    teamId: team.id,
    thoughts,
  }
}

const recall = async (
  prisma: PrismaClient,
  pool: Pool,
  s: Seed,
  sink: ConsumedSourceSink,
  holdsProjectWriteTools: boolean,
) => retrieveRelevantMemories(
  {
    prisma,
    searchConfig: { modelClient: { embed: async () => vector() }, pool },
  } as never,
  {
    agent: { agentKind: 'shared', id: s.agentId, systemSlug: null },
    channel: {
      dmKey: null,
      id: s.projectChannelId,
      organizationId: s.organizationId,
      projectId: s.projectId,
      systemChannelType: null,
      teamId: s.teamId,
    },
    consumedSources: sink,
    run: { id: randomUUID(), threadId: randomUUID() },
    task: { id: randomUUID() },
  } as never,
  {
    actorContext: {
      actionContext: { effectiveUserId: s.requesterId, requestId: randomUUID() },
      actor: { actorId: s.requesterId, actorType: 'user', roles: ['member'] },
      tenant: { organizationId: s.organizationId },
    },
  } as never,
  'webhook',
  { kind: 'local', organizationId: s.organizationId, userId: s.requesterId },
  { holdsProjectWriteTools },
)

const toolContext = (
  prisma: PrismaClient,
  pool: Pool,
  s: Seed,
  sink: ConsumedSourceSink,
): BuiltinToolRuntimeContext => ({
  actorContext: {
    actionContext: { effectiveUserId: s.requesterId, requestId: randomUUID() },
    actor: { actorId: s.requesterId, actorType: 'user', roles: ['member'] },
    tenant: { organizationId: s.organizationId },
  },
  agentId: s.agentId,
  agentKind: 'shared',
  channel: { id: s.projectChannelId, organizationId: s.organizationId, projectId: s.projectId },
  consumedSources: sink,
  ledgerIdentity: null,
  memoryCaptureConfig: { pool },
  prisma,
  realtimeTransport: { publishWs: async () => undefined },
  run: { id: randomUUID(), interactive: true, messageId: randomUUID(), threadId: randomUUID() },
  toolCallId: randomUUID(),
}) as unknown as BuiltinToolRuntimeContext

const withSeed = async (
  t: { after: (fn: () => Promise<void>) => void },
  run: (prisma: PrismaClient, pool: Pool, s: Seed) => Promise<void>,
): Promise<void> => {
  const prisma = new PrismaClient()
  const pool = new Pool({ connectionString: process.env.DATABASE_URL })
  const suffix = randomUUID()
  t.after(async () => {
    await prisma.organization.deleteMany({ where: { name: `recall-${suffix}` } })
    await prisma.user.deleteMany({ where: { email: { contains: suffix } } })
    await pool.end()
    await prisma.$disconnect()
  })
  await run(prisma, pool, await seed(prisma, pool, suffix))
}

runDatabaseTest('a run lent ticket writes recalls no private-DM memory and can still create a ticket', async (t) => {
  await withSeed(t, async (prisma, pool, s) => {
    const sink = createConsumedSourceSink()
    const memories = await recall(prisma, pool, s, sink, true)

    // Organisation knowledge still arrives; the DM-fed memory does not.
    assert.deepEqual(memories.map(({ id }) => id), [s.thoughts.clean])
    // Its organisation audience is provenance too, and the gate implies it.
    assert.deepEqual(sink.list(), [{ scopeId: s.organizationId, scopeType: 'organization' }])
    assert.deepEqual(sink.privateConversationSources(), [])

    await runTicketCreateTool(toolContext(prisma, pool, s, sink), { title: 'Harden webhook retries' })
    const ticket = await prisma.task.findFirst({
      where: { organizationId: s.organizationId, title: 'Harden webhook retries' },
    })
    assert.equal(ticket?.projectId, s.projectId)
  })
})

runDatabaseTest('a run without write tools recalls the private-DM memory exactly as before', async (t) => {
  await withSeed(t, async (prisma, pool, s) => {
    const sink = createConsumedSourceSink()
    const memories = await recall(prisma, pool, s, sink, false)

    assert.deepEqual(memories.map(({ id }) => id).sort(), [s.thoughts.clean, s.thoughts.fromDm].sort())
    assert.deepEqual(sink.list(), [
      { scopeId: s.organizationId, scopeType: 'organization' },
      { scopeId: s.dmId, scopeType: 'channel' },
    ])
    assert.deepEqual(sink.privateConversationSources(), [
      { sourceAuthorUserId: s.requesterId, sourceChannelId: s.dmId },
    ])
    // The gate is unchanged: that material still cannot reach the board.
    await assert.rejects(
      () => runTicketCreateTool(toolContext(prisma, pool, s, sink), { title: 'Should not land' }),
      { message: REFUSAL },
    )
  })
})

runDatabaseTest('listing channels no longer poisons the write basis', async (t) => {
  await withSeed(t, async (prisma, pool, s) => {
    const sink = createConsumedSourceSink()
    const context = toolContext(prisma, pool, s, sink)

    const listed = await runChannelListTool(context, {})
    // The DM and the private room are named — and neither is stamped.
    assert.match(listed.outputPreview ?? '', new RegExp(`channelId=${s.dmId}`))
    assert.match(listed.outputPreview ?? '', new RegExp(`channelId=${s.leadershipId}`))
    assert.deepEqual(sink.list(), [])

    await runTicketCreateTool(context, { title: 'After listing channels' })
    assert.equal(await prisma.task.count({
      where: { organizationId: s.organizationId, title: 'After listing channels' },
    }), 1)

    // Reading one channel's decision policy is a content read and still stamps.
    await runChannelListTool(context, { channelId: s.leadershipId })
    assert.deepEqual(sink.list(), [{ scopeId: s.leadershipId, scopeType: 'channel' }])
  })
})

runDatabaseTest('a genuine private-content read still stamps the basis and blocks the write', async (t) => {
  await withSeed(t, async (prisma, pool, s) => {
    const sink = createConsumedSourceSink()
    const context = toolContext(prisma, pool, s, sink)

    const found = await runTeamSearchTool(context, 'freeze')
    assert.match(found.outputPreview ?? '', /budget freeze/)
    assert.deepEqual(sink.list(), [{ scopeId: s.leadershipId, scopeType: 'channel' }])

    await assert.rejects(
      () => runTicketCreateTool(context, { title: 'Copy the freeze' }),
      { message: REFUSAL },
    )
    assert.equal(await prisma.task.count({
      where: { organizationId: s.organizationId, title: 'Copy the freeze' },
    }), 0)
  })
})
