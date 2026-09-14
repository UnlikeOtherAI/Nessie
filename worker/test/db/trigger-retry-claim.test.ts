import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import { PrismaClient } from '@prisma/client'
import { buildNextScheduledRunAt, MAX_DELIVERY_RETRIES } from '@nessie/runtime'

import {
  recordDeliveryFailure,
  retryFailedTriggerDeliveries,
} from '../../src/control/trigger-delivery-retry.js'
import { reattemptTriggerDelivery } from '../../src/control/trigger-retry-dispatch.js'
import { sweepDueScheduledTriggers } from '../../src/control/trigger-scheduler.js'
import { assertGlobalQueuesQuiet } from './support.js'

// The delivery-retry poller used a plain `findMany`, so two worker replicas
// selected the same due rows and re-attempted them concurrently. It now claims
// with `FOR UPDATE SKIP LOCKED`, exactly as the scheduler sweep does.
//
// This lives in `test/db/` because it drives a GLOBAL poller — the claim query
// takes the oldest due delivery anywhere in the database, so it needs a database
// where it is the only actor (docs/standards/testing.md).
const runDatabaseTest = process.env.DATABASE_URL ? test : test.skip

type Seed = {
  channelId: string
  organizationId: string
  triggerId: string
}

type ScheduledSeed = Seed & { nextRunAt: Date }

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
        // poller would then not see its own seed (docs/standards/testing.md).
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

const seedScheduledTrigger = async (
  prisma: PrismaClient,
  input: {
    config: Record<string, unknown>
    nextRunAt: Date
    type: 'interval' | 'scheduled'
  },
): Promise<ScheduledSeed> => {
  const org = await prisma.organization.create({ data: { name: `scheduled retry ${randomUUID()}` } })
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
      config: input.config,
      nextRunAt: input.nextRunAt,
      targetChannelId: channel.id,
      targetThreadId: thread.id,
      type: input.type,
    },
  })
  return {
    channelId: channel.id,
    nextRunAt: input.nextRunAt,
    organizationId: org.id,
    triggerId: trigger.id,
  }
}

const failFirstDispatchTransaction = (prisma: PrismaClient): PrismaClient => {
  let shouldFail = true
  return new Proxy(prisma, {
    get(target, property) {
      if (property === '$transaction') {
        return async <T>(callback: (tx: unknown) => Promise<T>): Promise<T> => {
          if (shouldFail) {
            shouldFail = false
            throw new Error('transient dispatch failure')
          }
          return target.$transaction(callback as never)
        }
      }
      const value = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}

const failFirstDispatchBeforeDeliveryRecord = (prisma: PrismaClient): PrismaClient => {
  let shouldFailDispatch = true
  let shouldFailRecord = true
  return new Proxy(prisma, {
    get(target, property) {
      if (property === '$transaction') {
        return async <T>(callback: (tx: unknown) => Promise<T>): Promise<T> => {
          if (shouldFailDispatch) {
            shouldFailDispatch = false
            throw new Error('transient dispatch failure')
          }
          return target.$transaction(callback as never)
        }
      }
      if (property === 'agentTriggerDelivery') {
        return new Proxy(target.agentTriggerDelivery, {
          get(delegate, delegateProperty) {
            if (delegateProperty === 'upsert') {
              return async (...args: unknown[]) => {
                if (shouldFailRecord) {
                  shouldFailRecord = false
                  throw new Error('transient delivery ledger failure')
                }
                return delegate.upsert(args[0] as never)
              }
            }
            const value = Reflect.get(delegate, delegateProperty, delegate)
            return typeof value === 'function' ? value.bind(delegate) : value
          },
        })
      }
      const value = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}

runDatabaseTest('concurrent pollers never claim the same delivery twice', async () => {
  const prisma = new PrismaClient()
  await assertGlobalQueuesQuiet(prisma)
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

runDatabaseTest('a scheduled delivery retry owns its occurrence and preserves cadence', async () => {
  const prisma = new PrismaClient()
  await assertGlobalQueuesQuiet(prisma)
  const now = new Date()
  const scheduledFor = new Date(now.getTime() - 120_000)
  const schedules: Array<{
    config: Record<string, unknown>
    name: string
    type: 'interval' | 'scheduled'
  }> = [
    {
      config: { at: scheduledFor.toISOString(), createdViaTool: true, mode: 'once' },
      name: 'one-off',
      type: 'scheduled',
    },
    {
      config: { cron: '0 0 1 1 *', createdViaTool: true },
      name: 'cron',
      type: 'scheduled',
    },
    {
      config: {
        createdViaTool: true,
        interval_minutes: 10_080,
        until: scheduledFor.toISOString(),
      },
      name: 'final interval',
      type: 'interval',
    },
    {
      config: { createdViaTool: true, interval_minutes: 10_080 },
      name: 'long interval',
      type: 'interval',
    },
  ]

  try {
    for (const schedule of schedules) {
      const seed = await seedScheduledTrigger(prisma, {
        config: schedule.config,
        nextRunAt: scheduledFor,
        type: schedule.type,
      })
      try {
        const expectedNextRunAt = buildNextScheduledRunAt({
          config: schedule.config,
          from: scheduledFor,
          now,
          type: schedule.type,
        })

        // The first transaction fails after the scheduler claimed this exact
        // occurrence. `queueTriggerRun` records a failed delivery outside that
        // transaction, which must become the only retry owner.
        await sweepDueScheduledTriggers(failFirstDispatchTransaction(prisma), {
          limit: 10,
          now,
        })

        const failed = await prisma.agentTriggerDelivery.findFirstOrThrow({
          where: { triggerId: seed.triggerId },
          select: { id: true, nextRetryAt: true, status: true },
        })
        assert.equal(failed.status, 'failed', `${schedule.name} records the failed occurrence`)
        assert.ok(failed.nextRetryAt, `${schedule.name} delivery is retryable`)

        const settled = await prisma.agentTrigger.findUniqueOrThrow({
          where: { id: seed.triggerId },
          select: { nextRunAt: true, schedulerClaimId: true, status: true },
        })
        assert.equal(settled.schedulerClaimId, null, `${schedule.name} releases scheduler ownership`)
        assert.equal(
          settled.nextRunAt?.toISOString() ?? null,
          expectedNextRunAt?.toISOString() ?? null,
          `${schedule.name} advances from the original occurrence`,
        )
        if (schedule.name === 'final interval') {
          assert.equal(settled.status, 'paused', 'the final cadence is settled without rearming')
        }

        await prisma.agentTriggerDelivery.update({
          where: { id: failed.id },
          data: { nextRetryAt: new Date(Date.now() - 60_000) },
        })

        // Two replicas race the delivery poller. The delivery claim gives only
        // one of them the original key, so it produces one kickoff/run.
        await Promise.all([
          retryFailedTriggerDeliveries(prisma, reattemptTriggerDelivery, { limit: 10 }),
          retryFailedTriggerDeliveries(prisma, reattemptTriggerDelivery, { limit: 10 }),
        ])

        assert.equal(
          await prisma.run.count({ where: { triggerId: seed.triggerId } }),
          1,
          `${schedule.name} delivery retry created exactly one run`,
        )
        assert.equal(
          await prisma.message.count({
            where: { threadId: (await prisma.thread.findFirstOrThrow({
              where: { channelId: seed.channelId }, select: { id: true },
            })).id, role: 'system' },
          }),
          1,
          `${schedule.name} delivery retry created exactly one kickoff`,
        )

        // A later scheduler sweep must see the settled cadence, never a
        // synthetic retry occurrence one minute after the original fire.
        await sweepDueScheduledTriggers(prisma, {
          limit: 10,
          now: new Date(now.getTime() + 120_000),
        })
        assert.equal(
          await prisma.run.count({ where: { triggerId: seed.triggerId } }),
          1,
          `${schedule.name} later scheduler sweep did not duplicate the run`,
        )
      } finally {
        await cleanup(prisma, seed)
      }
    }
  } finally {
    await prisma.$disconnect()
  }
})

runDatabaseTest('a scheduler-owned transient reclaims the original occurrence', async () => {
  const prisma = new PrismaClient()
  await assertGlobalQueuesQuiet(prisma)
  const now = new Date()
  const scheduledFor = new Date(now.getTime() - 120_000)
  const seed = await seedScheduledTrigger(prisma, {
    config: { createdViaTool: true, interval_minutes: 10_080 },
    nextRunAt: scheduledFor,
    type: 'interval',
  })

  try {
    // Both the dispatch transaction and the out-of-transaction failure ledger
    // write fail. With no durable delivery, the scheduler remains responsible
    // and must retry this occurrence after its ordinary fenced claim lease.
    await sweepDueScheduledTriggers(failFirstDispatchBeforeDeliveryRecord(prisma), {
      limit: 10,
      now,
    })

    const deferred = await prisma.agentTrigger.findUniqueOrThrow({
      where: { id: seed.triggerId },
      select: { nextRunAt: true, schedulerClaimId: true, schedulerClaimedAt: true },
    })
    assert.equal(deferred.nextRunAt?.toISOString(), scheduledFor.toISOString())
    assert.ok(deferred.schedulerClaimId)
    assert.ok(deferred.schedulerClaimedAt)
    assert.equal(
      await prisma.agentTriggerDelivery.count({ where: { triggerId: seed.triggerId } }),
      0,
    )

    await sweepDueScheduledTriggers(prisma, {
      limit: 10,
      now: new Date(now.getTime() + 60_001),
    })
    assert.equal(
      await prisma.run.count({ where: { triggerId: seed.triggerId } }),
      1,
      'the reclaimed original occurrence starts one run',
    )
  } finally {
    await cleanup(prisma, seed)
    await prisma.$disconnect()
  }
})

runDatabaseTest('delivery-owned cadence settlement preserves classified trigger health', async () => {
  const prisma = new PrismaClient()
  await assertGlobalQueuesQuiet(prisma)
  const now = new Date()
  const scheduledFor = new Date(now.getTime() - 120_000)
  const config = { interval_minutes: 10_080 }
  const seed = await seedScheduledTrigger(prisma, {
    config,
    nextRunAt: scheduledFor,
    type: 'interval',
  })

  try {
    // This legacy schedule fails the launch-origin gate. queueTriggerRun writes
    // both a failed delivery and classified `error` health before the scheduler
    // settles the original cadence.
    await sweepDueScheduledTriggers(prisma, { limit: 10, now })

    const trigger = await prisma.agentTrigger.findUniqueOrThrow({
      where: { id: seed.triggerId },
      select: { healthReason: true, nextRunAt: true, status: true },
    })
    assert.equal(trigger.status, 'error')
    assert.equal(trigger.healthReason, 'launch_origin_invalid')
    assert.equal(
      trigger.nextRunAt?.toISOString(),
      buildNextScheduledRunAt({
        config,
        from: scheduledFor,
        now,
        type: 'interval',
      })?.toISOString(),
    )
  } finally {
    await cleanup(prisma, seed)
    await prisma.$disconnect()
  }
})
