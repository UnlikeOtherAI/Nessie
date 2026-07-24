import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import { PrismaClient } from '@prisma/client'
import type { PgRealtimeTransport } from '@nessie/runtime'

import { dispatchNextMailboxMessage } from '../src/control/mailbox.js'

// Integration tests against the local Postgres (see AGENTS.md): mailbox
// deliveries take the same per-(agent, thread) claim as chat replies, so a
// delivery that arrives while a run is in flight pends instead of spawning a
// concurrent run.
const runDatabaseTest = process.env.DATABASE_URL ? test : test.skip

type Seed = {
  organizationId: string
  projectId: string
  teamId: string
  channelId: string
  threadId: string
  fromAgentId: string
  toAgentId: string
}

const seedWorkspace = async (prisma: PrismaClient): Promise<Seed> => {
  const org = await prisma.organization.create({ data: { name: `mbx-ser ${randomUUID()}` } })
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
    teamId: team.id,
    channelId: channel.id,
    threadId: thread.id,
    fromAgentId: fromAgent.id,
    toAgentId: toAgent.id,
  }
}

const cleanup = async (prisma: PrismaClient, seed: Seed) => {
  await prisma.$executeRaw`DELETE FROM queue_jobs WHERE idempotency_key LIKE ${'mailbox:%'}`
    .catch(() => undefined)
  await prisma.$executeRaw`DELETE FROM queue_jobs WHERE idempotency_key LIKE ${'run:batch:%'}`
    .catch(() => undefined)
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
}

const realtime = {
  publishSse: async () => undefined,
  publishWs: async () => undefined,
} as unknown as PgRealtimeTransport

const queueMail = async (
  prisma: PrismaClient,
  seed: Seed,
  body: string,
): Promise<{ id: string }> => {
  return prisma.agentMailboxMessage.create({
    data: {
      organizationId: seed.organizationId,
      fromAgentId: seed.fromAgentId,
      toAgentId: seed.toAgentId,
      channelId: seed.channelId,
      threadId: seed.threadId,
      actorId: seed.fromAgentId,
      actorType: 'agent',
      body,
      correlationId: randomUUID(),
    },
    select: { id: true },
  })
}

runDatabaseTest('mailbox delivery while the thread is busy pends instead of spawning a concurrent run', async (t) => {
  const prisma = new PrismaClient()
  const seed = await seedWorkspace(prisma)
  t.after(async () => {
    await cleanup(prisma, seed)
    await prisma.$disconnect()
  })

  // An in-flight run already holds the (agent, thread) slot.
  const activeRun = await prisma.run.create({
    data: { agentId: seed.toAgentId, threadId: seed.threadId, status: 'running' },
  })

  const mail = await queueMail(prisma, seed, 'subtask result payload')
  assert.equal(await dispatchNextMailboxMessage(prisma, realtime), true)

  // No concurrent run: the delivery is a durable pending marker instead.
  const runs = await prisma.run.findMany({
    where: { agentId: seed.toAgentId, threadId: seed.threadId },
  })
  assert.equal(runs.length, 1)
  assert.equal(runs[0]?.id, activeRun.id)

  const pendings = await prisma.runThreadPendingMessage.findMany({
    where: { agentId: seed.toAgentId, threadId: seed.threadId },
  })
  assert.equal(pendings.length, 1)
  assert.equal(pendings[0]?.channelId, seed.channelId)
  assert.equal(pendings[0]?.interactive, false)

  // The prompt message is in the thread and the mailbox row is delivered —
  // the pending marker IS the durable delivery.
  const promptMessage = await prisma.message.findUnique({
    where: { id: pendings[0]!.messageId },
  })
  assert.equal(promptMessage?.content, 'subtask result payload')
  const delivered = await prisma.agentMailboxMessage.findUnique({ where: { id: mail.id } })
  assert.equal(delivered?.status, 'delivered')
  assert.ok(delivered?.deliveredAt)

  // When the in-flight run goes terminal, the drain delivers the pended mail
  // as the batched follow-up run.
  await prisma.run.update({
    where: { id: activeRun.id },
    data: { status: 'completed', finishedAt: new Date() },
  })
  const { drainPendingThreadMessages } = await import('../src/run/thread-serialization.js')
  const followUpRunId = await drainPendingThreadMessages(prisma, {
    agentId: seed.toAgentId,
    threadId: seed.threadId,
  })
  assert.ok(followUpRunId)
  assert.equal(
    await prisma.runThreadPendingMessage.count({
      where: { agentId: seed.toAgentId, threadId: seed.threadId },
    }),
    0,
  )
})

runDatabaseTest('mailbox delivery on a free thread claims the slot and enqueues the run', async (t) => {
  const prisma = new PrismaClient()
  const seed = await seedWorkspace(prisma)
  t.after(async () => {
    await cleanup(prisma, seed)
    await prisma.$disconnect()
  })

  const mail = await queueMail(prisma, seed, 'do the subtask')
  assert.equal(await dispatchNextMailboxMessage(prisma, realtime), true)

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
