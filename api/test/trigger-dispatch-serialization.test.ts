import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import { PrismaClient } from '@prisma/client'
import { drainPendingThreadMessages } from '@nessie/db'

import { dispatchAgentTrigger } from '../src/services/trigger-dispatch.js'

// Integration tests against the local Postgres (see AGENTS.md): API-side
// trigger dispatch (webhook intake + manual fire) takes the same per-
// (agent, thread) claim as the worker paths, so a fire that arrives while a
// run is in flight is batched — not dropped and never concurrent.
const runDatabaseTest = process.env.DATABASE_URL ? test : test.skip

type Seed = {
  organizationId: string
  projectId: string
  teamId: string
  channelId: string
  threadId: string
  agentId: string
  triggerId: string
}

const seedWorkspace = async (prisma: PrismaClient): Promise<Seed> => {
  const org = await prisma.organization.create({ data: { name: `trg-ser ${randomUUID()}` } })
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
  const agent = await prisma.agent.create({ data: { name: 'A', organizationId: org.id } })
  await prisma.agentBinding.create({ data: { agentId: agent.id, channelId: channel.id } })
  const trigger = await prisma.agentTrigger.create({
    data: {
      agentId: agent.id,
      type: 'webhook',
      targetChannelId: channel.id,
      targetThreadId: thread.id,
    },
  })
  return {
    organizationId: org.id,
    projectId: project.id,
    teamId: team.id,
    channelId: channel.id,
    threadId: thread.id,
    agentId: agent.id,
    triggerId: trigger.id,
  }
}

const cleanup = async (prisma: PrismaClient, seed: Seed) => {
  await prisma.$executeRaw`DELETE FROM queue_jobs WHERE idempotency_key LIKE ${'run:batch:%'}`
    .catch(() => undefined)
  await prisma.runThreadPendingMessage.deleteMany({ where: { threadId: seed.threadId } })
  await prisma.agentTriggerDelivery.deleteMany({ where: { triggerId: seed.triggerId } })
  await prisma.taskEvent.deleteMany({ where: { task: { organizationId: seed.organizationId } } })
  await prisma.task.deleteMany({ where: { organizationId: seed.organizationId } })
  await prisma.message.deleteMany({ where: { threadId: seed.threadId } })
  await prisma.run.deleteMany({ where: { threadId: seed.threadId } })
  await prisma.agentTrigger.deleteMany({ where: { id: seed.triggerId } })
  await prisma.agentBinding.deleteMany({ where: { channelId: seed.channelId } })
  await prisma.thread.deleteMany({ where: { channelId: seed.channelId } })
  await prisma.channel.deleteMany({ where: { id: seed.channelId } })
  await prisma.agent.deleteMany({ where: { id: seed.agentId } })
  await prisma.team.deleteMany({ where: { id: seed.teamId } })
  await prisma.project.deleteMany({ where: { id: seed.projectId } })
  await prisma.organization.deleteMany({ where: { id: seed.organizationId } })
}

runDatabaseTest('webhook dispatch while a run is active pends, then drains into one linked follow-up', async (t) => {
  const prisma = new PrismaClient()
  const seed = await seedWorkspace(prisma)
  t.after(async () => {
    await cleanup(prisma, seed)
    await prisma.$disconnect()
  })

  // First fire claims the slot and creates the run.
  const first = await dispatchAgentTrigger(prisma, {
    dedupeKey: `d-${randomUUID()}`,
    payload: { n: 1 },
    source: 'webhook',
    triggerId: seed.triggerId,
  })
  assert.equal(first.kind, 'queued')
  if (first.kind !== 'queued') return
  assert.ok(first.runId)
  assert.equal(first.existing, false)

  // Second fire while the first run is in flight: batched, not dropped.
  const second = await dispatchAgentTrigger(prisma, {
    dedupeKey: `d-${randomUUID()}`,
    payload: { n: 2 },
    source: 'webhook',
    triggerId: seed.triggerId,
  })
  assert.equal(second.kind, 'queued')
  if (second.kind !== 'queued') return
  // No run yet — the fire is a durable pending marker + delivered delivery.
  assert.equal(second.runId, undefined)
  assert.equal(second.delivery.status, 'delivered')

  const runs = await prisma.run.findMany({
    where: { agentId: seed.agentId, threadId: seed.threadId },
  })
  assert.equal(runs.length, 1)

  const pendings = await prisma.runThreadPendingMessage.findMany({
    where: { agentId: seed.agentId, threadId: seed.threadId },
  })
  assert.equal(pendings.length, 1)
  assert.equal(pendings[0]?.triggerId, seed.triggerId)
  assert.equal(pendings[0]?.triggerDeliveryId, second.delivery.id)

  // A dedupe-key replay of the pended fire is recognized as existing (never
  // re-fired, never mis-marked failed).
  const replay = await dispatchAgentTrigger(prisma, {
    dedupeKey: second.delivery.dedupeKey,
    payload: { n: 2 },
    source: 'webhook',
    triggerId: seed.triggerId,
  })
  assert.equal(replay.kind, 'queued')
  if (replay.kind !== 'queued') return
  assert.equal(replay.existing, true)
  const deliveryAfterReplay = await prisma.agentTriggerDelivery.findUnique({
    where: { id: second.delivery.id },
  })
  assert.equal(deliveryAfterReplay?.status, 'delivered')

  // The in-flight run goes terminal; the drain delivers the pended fire as
  // ONE follow-up run carrying the trigger linkage.
  await prisma.run.update({
    where: { id: runs[0]!.id },
    data: { status: 'completed', finishedAt: new Date() },
  })
  const followUpRunId = await drainPendingThreadMessages(prisma, {
    agentId: seed.agentId,
    threadId: seed.threadId,
  })
  assert.ok(followUpRunId)

  const followUp = await prisma.run.findUniqueOrThrow({ where: { id: followUpRunId } })
  assert.equal(followUp.triggerId, seed.triggerId)
  assert.equal(followUp.triggerDeliveryId, second.delivery.id)
  assert.equal(
    await prisma.runThreadPendingMessage.count({
      where: { agentId: seed.agentId, threadId: seed.threadId },
    }),
    0,
  )
  assert.equal(
    (await prisma.run.findMany({ where: { agentId: seed.agentId, threadId: seed.threadId } }))
      .length,
    2,
  )
})
