import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

import { PrismaClient } from '@prisma/client'
import { viewerSatisfiesBasis, type PgRealtimeTransport } from '@nessie/runtime'

import { dispatchNextMailboxMessage } from '../../src/control/mailbox.js'
import { runReplyBasis } from '../../src/run/execute/agent-message.js'
import { createConsumedSourceSink } from '../../src/run/execute/disclosure-basis.js'
import type { RunContext } from '../../src/run/execute/types.js'
import {
  assertGlobalQueuesQuiet,
  deleteThreadQueueJobs,
  runDatabaseTest,
} from './support.js'

// Integration tests against the local Postgres (see AGENTS.md): mailbox
// deliveries take the same per-(agent, thread) claim as chat replies, so a
// delivery that arrives while a run is in flight pends instead of spawning a
// concurrent run.
//
// `dispatchNextMailboxMessage` is a GLOBAL poller — it claims the oldest queued
// mailbox row in the database, with no tenant filter — so these tests can only
// assert their own delivery when no other queued mail exists. Hence the
// `assertGlobalQueuesQuiet` preflight; see `./support.ts`.

type Seed = {
  organizationId: string
  projectId: string
  requesterId: string
  teamId: string
  channelId: string
  threadId: string
  fromAgentId: string
  toAgentId: string
}

const seedTeam = async (prisma: PrismaClient): Promise<Seed> => {
  const org = await prisma.organization.create({ data: { name: `mbx-ser ${randomUUID()}` } })
  const requester = await prisma.user.create({ data: { displayName: 'Requester', email: `mbx-${randomUUID()}@example.test` } })
  await prisma.organizationMember.create({ data: { organizationId: org.id, role: 'owner', userId: requester.id } })
  const project = await prisma.project.create({
    data: { name: 'p', organizationId: org.id },
  })
  const team = await prisma.team.create({ data: { name: 't', projectId: project.id } })
  const channel = await prisma.channel.create({
    data: {
      label: 'c',
      slug: `c-${randomUUID()}`,
      organizationId: org.id,
      projectId: project.id,
      teamId: team.id,
    },
  })
  const thread = await prisma.thread.create({ data: { channelId: channel.id } })
  const fromAgent = await prisma.agent.create({
    data: { name: 'From', organizationId: org.id },
  })
  const toAgent = await prisma.agent.create({ data: { name: 'To', organizationId: org.id } })
  await prisma.agentBinding.create({
    data: { agentId: toAgent.id, channelId: channel.id },
  })
  return {
    organizationId: org.id,
    projectId: project.id,
    requesterId: requester.id,
    teamId: team.id,
    channelId: channel.id,
    threadId: thread.id,
    fromAgentId: fromAgent.id,
    toAgentId: toAgent.id,
  }
}

const cleanup = async (prisma: PrismaClient, seed: Seed) => {
  await deleteThreadQueueJobs(prisma, seed.threadId)
  await prisma.runThreadPendingMessage.deleteMany({ where: { threadId: seed.threadId } })
  await prisma.agentMailboxMessage.deleteMany({ where: { organizationId: seed.organizationId } })
  await prisma.taskEvent.deleteMany({ where: { task: { organizationId: seed.organizationId } } })
  await prisma.task.deleteMany({ where: { organizationId: seed.organizationId } })
  await prisma.message.deleteMany({ where: { threadId: seed.threadId } })
  await prisma.run.deleteMany({ where: { threadId: seed.threadId } })
  await prisma.agentBinding.deleteMany({ where: { channelId: seed.channelId } })
  await prisma.thread.deleteMany({ where: { channelId: seed.channelId } })
  await prisma.channel.deleteMany({ where: { id: seed.channelId } })
  await prisma.agent.deleteMany({ where: { id: { in: [seed.fromAgentId, seed.toAgentId] } } })
  await prisma.team.deleteMany({ where: { id: seed.teamId } })
  await prisma.project.deleteMany({ where: { id: seed.projectId } })
  await prisma.organization.deleteMany({ where: { id: seed.organizationId } })
  await prisma.user.deleteMany({ where: { id: seed.requesterId } })
}

const realtime = {
  publishSse: async () => undefined,
  publishWs: async () => undefined,
} as unknown as PgRealtimeTransport

// `visibleAt` is set explicitly in the past instead of defaulting to
// `CURRENT_TIMESTAMP`. The column is `timestamp(3)`, and Postgres ROUNDS to
// that precision on storage while the poller's `visible_at <= now()` predicate
// compares against full-microsecond `now()` — so a row written at x.9995ms is
// stored as (x+1).000ms and is briefly due in the future. The real poller loops
// and picks it up microseconds later; a test that dispatches exactly once would
// just be flaky (~1 in 10). What these tests are about is the (agent, thread)
// claim, not visibility timing, so the seeded mail is unambiguously due.
const queueMail = async (
  prisma: PrismaClient,
  seed: Seed,
  body: string,
  peerDelegationDepth?: number,
  basis: { scopeId: string; scopeType: string }[] = [],
  disclosureSources: { sourceAuthorUserId: string | null; sourceChannelId: string }[] = [],
): Promise<{ id: string }> => {
  return prisma.agentMailboxMessage.create({
    data: {
      organizationId: seed.organizationId,
      fromAgentId: seed.fromAgentId,
      toAgentId: seed.toAgentId,
      channelId: seed.channelId,
      threadId: seed.threadId,
      actorId: peerDelegationDepth === undefined ? seed.fromAgentId : seed.requesterId,
      actorType: peerDelegationDepth === undefined ? 'agent' : 'user',
      basis,
      disclosureSources,
      body,
      correlationId: randomUUID(),
      peerDelegationDepth,
      visibleAt: new Date(Date.now() - 60_000),
    },
    select: { id: true },
  })
}

// Dispatch and prove the seeded mail is the row that was claimed. The poller
// picks the globally oldest queued message, so a foreign row appearing between
// the preflight and here would otherwise surface as a confusing "0 pending
// markers" further down instead of naming the real cause.
const dispatchSeededMail = async (
  prisma: PrismaClient,
  mail: { id: string },
): Promise<void> => {
  assert.equal(await dispatchNextMailboxMessage(prisma, realtime), true)
  const dispatched = await prisma.agentMailboxMessage.findUnique({
    where: { id: mail.id },
    select: { status: true },
  })
  assert.equal(
    dispatched?.status,
    'delivered',
    'the poller claimed a different mailbox row — the database is not exclusive to this suite',
  )
}

runDatabaseTest('mailbox delivery while the thread is busy pends instead of spawning a concurrent run', async (t) => {
  const prisma = new PrismaClient()
  await assertGlobalQueuesQuiet(prisma)
  const seed = await seedTeam(prisma)
  t.after(async () => {
    await cleanup(prisma, seed)
    await prisma.$disconnect()
  })

  // An in-flight run already holds the (agent, thread) slot.
  const activeRun = await prisma.run.create({
    data: { agentId: seed.toAgentId, threadId: seed.threadId, status: 'running' },
  })

  const mail = await queueMail(prisma, seed, 'subtask result payload one')
  const mailTwo = await queueMail(prisma, seed, 'subtask result payload two')
  const mailThree = await queueMail(prisma, seed, 'subtask result payload three')
  await dispatchSeededMail(prisma, mail)
  await dispatchSeededMail(prisma, mailTwo)
  await dispatchSeededMail(prisma, mailThree)

  // No concurrent run: the delivery is a durable pending marker instead.
  const runs = await prisma.run.findMany({
    where: { agentId: seed.toAgentId, threadId: seed.threadId },
  })
  assert.equal(runs.length, 1)
  assert.equal(runs[0]?.id, activeRun.id)

  const pendings = await prisma.runThreadPendingMessage.findMany({
    where: { agentId: seed.toAgentId, threadId: seed.threadId },
  })
  assert.equal(pendings.length, 3)
  assert.equal(pendings[0]?.channelId, seed.channelId)
  assert.equal(pendings[0]?.interactive, false)

  // The prompt message is in the thread and the mailbox row is delivered —
  // the pending marker IS the durable delivery.
  const promptMessage = await prisma.message.findUnique({
    where: { id: pendings[0]!.messageId },
  })
  assert.equal(promptMessage?.content, 'subtask result payload one')
  const delivered = await prisma.agentMailboxMessage.findUnique({ where: { id: mail.id } })
  assert.equal(delivered?.status, 'delivered')
  assert.ok(delivered?.deliveredAt)

  // When the in-flight run goes terminal, the drain delivers the pended mail
  // as the batched follow-up run.
  await prisma.run.update({
    where: { id: activeRun.id },
    data: { status: 'completed', finishedAt: new Date() },
  })
  const { drainPendingThreadMessages } = await import('../../src/run/thread-serialization.js')
  const followUpRunId = await drainPendingThreadMessages(prisma, {
    agentId: seed.toAgentId,
    threadId: seed.threadId,
  })
  assert.ok(followUpRunId)
  const batch = await prisma.$queryRaw<{ payload: { promptOverride?: string } }[]>`
    SELECT payload FROM queue_jobs WHERE idempotency_key = ${`run:batch:${followUpRunId}`}
  `
  assert.match(batch[0]?.payload.promptOverride ?? '', /payload one/)
  assert.match(batch[0]?.payload.promptOverride ?? '', /payload two/)
  assert.match(batch[0]?.payload.promptOverride ?? '', /payload three/)
  assert.equal(
    await prisma.runThreadPendingMessage.count({
      where: { agentId: seed.toAgentId, threadId: seed.threadId },
    }),
    0,
  )
})

runDatabaseTest('peer delivery keeps a restricted research basis through the coordinator reply ACL', async (t) => {
  const prisma = new PrismaClient()
  await assertGlobalQueuesQuiet(prisma)
  const seed = await seedTeam(prisma)
  t.after(async () => {
    await cleanup(prisma, seed)
    await prisma.$disconnect()
  })

  const sourceBasis = [{ scopeId: seed.requesterId, scopeType: 'user' }]
  const disclosureSources = [
    { sourceAuthorUserId: seed.requesterId, sourceChannelId: seed.channelId },
    { sourceAuthorUserId: null, sourceChannelId: seed.channelId },
  ]
  const mail = await queueMail(
    prisma,
    seed,
    'review the prospect evidence',
    2,
    sourceBasis,
    disclosureSources,
  )
  await dispatchSeededMail(prisma, mail)

  const rows = await prisma.$queryRaw<{ payload: { actorContext: { actionContext: { correlationId?: string; effectiveUserId?: string; purpose?: string }; tenant: { projectId?: string; teamId?: string } } } }[]>`
    SELECT payload FROM queue_jobs WHERE idempotency_key = ${`mailbox:${mail.id}`}
  `
  assert.equal(rows.length, 1)
  assert.equal(rows[0]?.payload.actorContext.actionContext.purpose, 'agent.peer_delegation')
  assert.equal(rows[0]?.payload.actorContext.actionContext.correlationId, '2')
  assert.equal(rows[0]?.payload.actorContext.actionContext.effectiveUserId, seed.requesterId)
  assert.equal(rows[0]?.payload.actorContext.tenant.projectId, seed.projectId)
  assert.equal(rows[0]?.payload.actorContext.tenant.teamId, seed.teamId)

  const prompt = await prisma.message.findFirstOrThrow({
    where: { content: 'review the prospect evidence', threadId: seed.threadId },
    select: {
      basisScopes: { select: { scopeId: true, scopeType: true } },
      disclosureSources: { select: { sourceAuthorUserId: true, sourceChannelId: true } },
      role: true,
    },
  })
  assert.equal(prompt.role, 'system')
  assert.deepEqual(prompt.basisScopes, sourceBasis)
  assert.deepEqual(prompt.disclosureSources, disclosureSources)

  const run = await prisma.run.findFirstOrThrow({
    where: { agentId: seed.toAgentId, threadId: seed.threadId },
    select: { basisScopes: { select: { scopeId: true, scopeType: true } } },
  })
  assert.deepEqual(run.basisScopes, sourceBasis)

  // run-job admits the stamped prompt basis into this sink before the model
  // starts. The ordinary project channel does not imply a person-only source,
  // so every coordinator reply retains that source ACL at read time.
  const consumedSources = createConsumedSourceSink()
  consumedSources.addAll(prompt.basisScopes)
  const outputBasis = runReplyBasis({
    boundAgentIds: [],
    channel: {
      id: seed.channelId,
      organizationId: seed.organizationId,
      projectId: seed.projectId,
      systemChannelType: null,
      teamId: seed.teamId,
    },
    consumedSources,
  } as RunContext)
  assert.deepEqual(outputBasis, sourceBasis)
  assert.equal(viewerSatisfiesBasis(outputBasis, {
    kind: 'user', scopes: sourceBasis, userId: seed.requesterId,
  }), true)
  assert.equal(viewerSatisfiesBasis(outputBasis, {
    kind: 'user', scopes: [], userId: randomUUID(),
  }), false)

  // The delivery row is terminal; replaying the sweep cannot create a second run.
  assert.equal(await dispatchNextMailboxMessage(prisma, realtime), false)
  assert.equal(await prisma.run.count({ where: { agentId: seed.toAgentId, threadId: seed.threadId } }), 1)
})

runDatabaseTest('mailbox delivery on a free thread claims the slot and enqueues the run', async (t) => {
  const prisma = new PrismaClient()
  await assertGlobalQueuesQuiet(prisma)
  const seed = await seedTeam(prisma)
  t.after(async () => {
    await cleanup(prisma, seed)
    await prisma.$disconnect()
  })

  const mail = await queueMail(prisma, seed, 'do the subtask')
  await dispatchSeededMail(prisma, mail)

  const runs = await prisma.run.findMany({
    where: { agentId: seed.toAgentId, threadId: seed.threadId },
  })
  assert.equal(runs.length, 1)
  assert.equal(runs[0]?.status, 'pending')
  assert.equal(
    await prisma.runThreadPendingMessage.count({
      where: { agentId: seed.toAgentId, threadId: seed.threadId },
    }),
    0,
  )

  const job = await prisma.$queryRaw<{ count: bigint }[]>`
    SELECT COUNT(*)::bigint AS count FROM queue_jobs WHERE idempotency_key = ${`mailbox:${mail.id}`}
  `
  assert.equal(Number(job[0]?.count ?? 0), 1)

  const delivered = await prisma.agentMailboxMessage.findUnique({ where: { id: mail.id } })
  assert.equal(delivered?.status, 'delivered')
})
