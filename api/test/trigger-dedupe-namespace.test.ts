import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import { PrismaClient } from '@prisma/client'

import { dispatchAgentTrigger } from '../src/services/trigger-dispatch.js'

// Delivery dedupe keys share one namespace per trigger, and the scheduler's are
// predictable: `scheduled:<triggerId>:<next run ISO>`. `queueTriggerRun` skips a
// fire whose (trigger, dedupeKey) delivery already exists, so a caller able to
// name that exact string from the member-level manual-fire endpoint could
// pre-create the row for a future occurrence and silently cancel it.
//
// Dispatch now prefixes every caller-supplied key with the route's own
// server-decided source, so a caller can only ever collide with themselves.
const runDatabaseTest = process.env.DATABASE_URL ? test : test.skip

type Seed = {
  channelId: string
  organizationId: string
  triggerId: string
}

const seedScheduledTrigger = async (prisma: PrismaClient): Promise<Seed> => {
  const org = await prisma.organization.create({ data: { name: `trg-ns ${randomUUID()}` } })
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
      config: { interval_minutes: 15 },
      nextRunAt: new Date('2026-09-01T00:00:00.000Z'),
      targetChannelId: channel.id,
      targetThreadId: thread.id,
      type: 'interval',
    },
  })

  return { channelId: channel.id, organizationId: org.id, triggerId: trigger.id }
}

runDatabaseTest('a manual fire cannot claim a scheduled occurrence key', async () => {
  const prisma = new PrismaClient()
  const seed = await seedScheduledTrigger(prisma)
  // Exactly what the sweep will use for the armed occurrence.
  const schedulerKey = `scheduled:${seed.triggerId}:2026-09-01T00:00:00.000Z`

  try {
    const dispatched = await dispatchAgentTrigger(prisma, {
      dedupeKey: schedulerKey,
      payload: {},
      source: 'manual',
      triggerId: seed.triggerId,
    })
    assert.notEqual(dispatched.kind, 'rejected')

    // The scheduler's key must still be free, or its fire would be skipped.
    const collision = await prisma.agentTriggerDelivery.findFirst({
      where: { dedupeKey: schedulerKey, triggerId: seed.triggerId },
      select: { id: true },
    })
    assert.equal(
      collision,
      null,
      'the caller must not be able to occupy the scheduler occurrence key',
    )

    const stored = await prisma.agentTriggerDelivery.findMany({
      where: { triggerId: seed.triggerId },
      select: { dedupeKey: true },
    })
    assert.equal(stored.length, 1)
    assert.equal(stored[0]?.dedupeKey, `manual:${schedulerKey}`)
  } finally {
    await prisma.$executeRawUnsafe(
      'DELETE FROM queue_jobs WHERE payload->>\'threadId\' IN '
      + '(SELECT id::text FROM threads WHERE channel_id = $1::uuid)',
      seed.channelId,
    )
    await prisma.organization.delete({ where: { id: seed.organizationId } })
    await prisma.$disconnect()
  }
})

runDatabaseTest('idempotency still holds within a caller namespace', async () => {
  const prisma = new PrismaClient()
  const seed = await seedScheduledTrigger(prisma)
  const key = `client-${randomUUID()}`

  try {
    const first = await dispatchAgentTrigger(prisma, {
      dedupeKey: key,
      payload: {},
      source: 'manual',
      triggerId: seed.triggerId,
    })
    const second = await dispatchAgentTrigger(prisma, {
      dedupeKey: key,
      payload: {},
      source: 'manual',
      triggerId: seed.triggerId,
    })

    assert.notEqual(first.kind, 'rejected')
    assert.notEqual(second.kind, 'rejected')
    if (second.kind === 'rejected') return
    assert.equal(second.existing, true, 'the repeat fire must resolve to the first delivery')

    const stored = await prisma.agentTriggerDelivery.count({
      where: { triggerId: seed.triggerId },
    })
    assert.equal(stored, 1, 'namespacing must not break same-caller idempotency')
  } finally {
    await prisma.$executeRawUnsafe(
      'DELETE FROM queue_jobs WHERE payload->>\'threadId\' IN '
      + '(SELECT id::text FROM threads WHERE channel_id = $1::uuid)',
      seed.channelId,
    )
    await prisma.organization.delete({ where: { id: seed.organizationId } })
    await prisma.$disconnect()
  }
})
