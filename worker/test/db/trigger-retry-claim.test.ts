import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import { PrismaClient } from '@prisma/client'
import { MAX_DELIVERY_RETRIES } from '@nessie/runtime'

import {
  recordDeliveryFailure,
  retryFailedTriggerDeliveries,
} from '../../src/control/trigger-delivery-retry.js'

// The delivery-retry poller used a plain `findMany`, so two worker replicas
// selected the same due rows and re-attempted them concurrently. It now claims
// with `FOR UPDATE SKIP LOCKED`, exactly as the scheduler sweep does.
//
// This lives in `test/db/` because it drives a GLOBAL poller — the claim query
// takes the oldest due delivery anywhere in the database, so it needs a database
// where it is the only actor (AGENTS.md → Workflow).
const runDatabaseTest = process.env.DATABASE_URL ? test : test.skip

type Seed = {
  channelId: string
  organizationId: string
  triggerId: string
}

const seedFailedDeliveries = async (
  prisma: PrismaClient,
  count: number,
): Promise<Seed> => {
  const org = await prisma.organization.create({ data: { name: `retry ${randomUUID()}` } })
  const project = await prisma.project.create({ data: { name: 'p', organizationId: org.id } })
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
      config: {},
      targetChannelId: channel.id,
      targetThreadId: thread.id,
      type: 'webhook',
    },
  })

  for (let index = 0; index < count; index += 1) {
    await prisma.agentTriggerDelivery.create({
      data: {
        dedupeKey: `webhook:${randomUUID()}`,
        // Explicitly in the past: `timestamp(3)` rounding can put a
        // just-written value fractionally in the future, and a single-shot
        // poller would then not see its own seed (AGENTS.md → Workflow).
        nextRetryAt: new Date(Date.now() - 60_000),
        payload: {},
        retryCount: 1,
        source: 'webhook',
        status: 'failed',
        triggerId: trigger.id,
      },
    })
  }

  return { channelId: channel.id, organizationId: org.id, triggerId: trigger.id }
}

const cleanup = async (prisma: PrismaClient, seed: Seed): Promise<void> => {
  await prisma.$executeRawUnsafe(
    'DELETE FROM queue_jobs WHERE payload->>\'threadId\' IN '
    + '(SELECT id::text FROM threads WHERE channel_id = $1::uuid)',
    seed.channelId,
  )
  await prisma.organization.delete({ where: { id: seed.organizationId } })
}

runDatabaseTest('concurrent pollers never claim the same delivery twice', async () => {
  const prisma = new PrismaClient()
  const seed = await seedFailedDeliveries(prisma, 4)
  const claimed: string[] = []

  try {
    // Two pollers racing, as two worker replicas would. Each records what it was
    // handed; the union must contain no duplicates.
    const record = async (
      _prisma: PrismaClient,
      input: { reuseDeliveryId: string },
    ): Promise<void> => {
      claimed.push(input.reuseDeliveryId)
    }
    await Promise.all([
      retryFailedTriggerDeliveries(prisma, record, { limit: 4 }),
      retryFailedTriggerDeliveries(prisma, record, { limit: 4 }),
    ])

    assert.equal(
      claimed.length,
      new Set(claimed).size,
      `a delivery was handed to two pollers: ${claimed.join(', ')}`,
    )
    assert.ok(claimed.length > 0, 'the seeded deliveries should have been claimed')
  } finally {
    await cleanup(prisma, seed)
    await prisma.$disconnect()
  }
})

runDatabaseTest('an exhausted delivery keeps no due retry timestamp', async () => {
  const prisma = new PrismaClient()
  const seed = await seedFailedDeliveries(prisma, 1)

  try {
    const delivery = await prisma.agentTriggerDelivery.findFirstOrThrow({
      where: { triggerId: seed.triggerId },
      select: { id: true },
    })

    // The attempt that lands exactly on the cap. `recordDeliveryFailure` used
    // `> MAX` while the poller selects `< MAX`, so this row kept a due
    // `nextRetryAt` that nothing would ever pick up.
    await recordDeliveryFailure(prisma, {
      error: new Error('boom'),
      existingDeliveryId: delivery.id,
      payload: {},
      retryCount: MAX_DELIVERY_RETRIES - 1,
      source: 'webhook',
      triggerId: seed.triggerId,
    })

    const settled = await prisma.agentTriggerDelivery.findUniqueOrThrow({
      where: { id: delivery.id },
      select: { nextRetryAt: true, retryCount: true },
    })
    assert.equal(settled.retryCount, MAX_DELIVERY_RETRIES)
    assert.equal(
      settled.nextRetryAt,
      null,
      'a delivery the poller can never select must not claim a pending retry',
    )
  } finally {
    await cleanup(prisma, seed)
    await prisma.$disconnect()
  }
})
