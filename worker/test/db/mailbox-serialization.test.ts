import assert from 'node:assert/strict'

import { PrismaClient } from '@prisma/client'

import { dispatchNextMailboxMessage } from '../../src/control/mailbox.js'
import { assertGlobalQueuesQuiet, runDatabaseTest } from './support.js'
import {
  cleanup,
  dispatchSeededMail,
  peerIdentity,
  queueMail,
  realtime,
  seedTeam,
} from './mailbox-serialization-fixture.js'
// Integration tests against the local Postgres (see AGENTS.md): mailbox
// deliveries take the same per-(agent, thread) claim as chat replies, so a
// delivery that arrives while a run is in flight pends instead of spawning a
// concurrent run.
//
// `dispatchNextMailboxMessage` is a GLOBAL poller — it claims the oldest queued
// mailbox row in the database, with no tenant filter — so these tests can only
// assert their own delivery when no other queued mail exists. Hence the
// `assertGlobalQueuesQuiet` preflight; see `./support.ts`.

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

  const mail = await queueMail(prisma, seed, 'subtask result payload one', 1, [], [], undefined, peerIdentity('requester-one'))
  const mailTwo = await queueMail(prisma, seed, 'subtask result payload two', 1, [], [], seed.secondRequesterId, peerIdentity('requester-two'))
  const mailThree = await queueMail(prisma, seed, 'subtask result payload three', 1, [], [], undefined, peerIdentity('requester-one'))
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

  // A failed predecessor drains each peer brief in arrival order. Each successor
  // keeps the hidden message and human authority that admitted it; neither a
  // later human turn nor another peer's restricted basis can replace either.
  const { drainPendingThreadMessages } = await import('../../src/run/thread-serialization.js')
  let predecessorId = activeRun.id
  const successorIds: string[] = []
  for (const [expectedUserId, expectedIdentity] of [
    [seed.requesterId, peerIdentity('requester-one')],
    [seed.secondRequesterId, peerIdentity('requester-two')],
    [seed.requesterId, peerIdentity('requester-one')],
  ] as const) {
    await prisma.run.update({
      where: { id: predecessorId },
      data: { status: 'failed', finishedAt: new Date() },
    })
    const followUpRunId = await drainPendingThreadMessages(prisma, {
      agentId: seed.toAgentId,
      threadId: seed.threadId,
    })
    assert.ok(followUpRunId)
    successorIds.push(followUpRunId)
    const rows = await prisma.$queryRaw<{ payload: { actorContext: { actionContext: { effectiveUserId?: string; purpose?: string; uoaIdentity?: unknown } } } }[]>`
      SELECT payload FROM queue_jobs WHERE payload->>'runId' = ${followUpRunId}
    `
    assert.equal(rows.length, 1)
    assert.equal(rows[0]?.payload.actorContext.actionContext.purpose, 'agent.peer_delegation')
    assert.equal(rows[0]?.payload.actorContext.actionContext.effectiveUserId, expectedUserId)
    assert.deepEqual(rows[0]?.payload.actorContext.actionContext.uoaIdentity, expectedIdentity)
    predecessorId = followUpRunId
  }
  assert.equal(
    await prisma.runThreadPendingMessage.count({
      where: { agentId: seed.toAgentId, threadId: seed.threadId },
    }),
    0,
    'all delivered peer briefs make progress after each failed predecessor',
  )
  assert.equal(new Set(successorIds).size, 3)
})

runDatabaseTest('a malformed durable peer identity creates no run', async (t) => {
  const prisma = new PrismaClient()
  await assertGlobalQueuesQuiet(prisma)
  const seed = await seedTeam(prisma)
  t.after(async () => {
    await cleanup(prisma, seed)
    await prisma.$disconnect()
  })

  await queueMail(
    prisma,
    seed,
    'bad peer provenance',
    1,
    [],
    [],
    undefined,
    { organizationId: 'uoa-org', subject: 'uoa-user', teamId: 'uoa-team', tokenVersion: 'seven' },
  )
  await assert.rejects(
    dispatchNextMailboxMessage(prisma, realtime),
    /Expected number, received string/,
  )
  assert.equal(
    await prisma.run.count({ where: { agentId: seed.toAgentId, threadId: seed.threadId } }),
    0,
  )
})

runDatabaseTest('a later scheduled marker cannot replace a selected peer brief', async (t) => {
  const prisma = new PrismaClient()
  await assertGlobalQueuesQuiet(prisma)
  const seed = await seedTeam(prisma)
  t.after(async () => {
    await cleanup(prisma, seed)
    await prisma.$disconnect()
  })

  const activeRun = await prisma.run.create({
    data: { agentId: seed.toAgentId, threadId: seed.threadId, status: 'running' },
  })
  const basis = [{ scopeId: seed.requesterId, scopeType: 'user' }]
  const peerMail = await queueMail(prisma, seed, 'restricted peer brief', 1, basis)
  await dispatchSeededMail(prisma, peerMail)
  const peerPending = await prisma.runThreadPendingMessage.findFirstOrThrow({
    where: { agentId: seed.toAgentId, threadId: seed.threadId },
  })

  const template = await prisma.agentTodoTemplate.create({
    data: {
      agentId: seed.toAgentId,
      authorType: 'user',
      name: 'Later schedule',
      organizationId: seed.organizationId,
      status: 'active',
      steps: [{ instructions: 'Check later.', key: 'later', title: 'Later' }],
    },
  })
  const trigger = await prisma.agentTrigger.create({
    data: {
      agentId: seed.toAgentId,
      config: { interval_minutes: 15 },
      targetChannelId: seed.channelId,
      targetThreadId: seed.threadId,
      type: 'interval',
    },
  })
  const scheduledMessage = await prisma.message.create({
    data: {
      content: 'later scheduled kickoff',
      createdAt: new Date(Date.now() + 1_000),
      role: 'system',
      threadId: seed.threadId,
    },
  })
  await prisma.runThreadPendingMessage.create({
    data: {
      actorContext: peerPending.actorContext,
      agentId: seed.toAgentId,
      channelId: seed.channelId,
      interactive: false,
      messageId: scheduledMessage.id,
      threadId: seed.threadId,
      todoTemplateId: template.id,
      triggerId: trigger.id,
    },
  })

  const beforeDrain = await prisma.runThreadPendingMessage.findMany({
    where: { agentId: seed.toAgentId, threadId: seed.threadId },
    orderBy: [{ message: { createdAt: 'asc' } }, { seq: 'asc' }],
    include: { message: { select: { content: true } } },
  })
  assert.deepEqual(beforeDrain.map((pending) => pending.messageId), [peerPending.messageId, scheduledMessage.id])

  await prisma.run.update({ where: { id: activeRun.id }, data: { status: 'failed', finishedAt: new Date() } })
  const { drainPendingThreadMessages } = await import('../../src/run/thread-serialization.js')
  const successorId = await drainPendingThreadMessages(prisma, {
    agentId: seed.toAgentId,
    threadId: seed.threadId,
  })
  assert.ok(successorId)
  const jobs = await prisma.$queryRaw<{ payload: { messageId: string } }[]>`
    SELECT payload FROM queue_jobs WHERE payload->>'runId' = ${successorId}
  `
  assert.equal(jobs.length, 1)
  assert.equal(jobs[0]?.payload.messageId, peerPending.messageId)
  const run = await prisma.run.findUniqueOrThrow({
    where: { id: successorId },
    select: { triggerMessageId: true },
  })
  assert.equal(run.triggerMessageId, peerPending.messageId)
  const selectedPrompt = await prisma.message.findUniqueOrThrow({
    where: { id: peerPending.messageId },
    select: { basisScopes: { select: { scopeId: true, scopeType: true } }, content: true },
  })
  assert.equal(selectedPrompt.content, 'restricted peer brief')
  assert.deepEqual(selectedPrompt.basisScopes, basis)
  const remaining = await prisma.runThreadPendingMessage.findMany({
    where: { agentId: seed.toAgentId, threadId: seed.threadId },
  })
  assert.deepEqual(remaining.map((pending) => pending.messageId), [scheduledMessage.id])
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
