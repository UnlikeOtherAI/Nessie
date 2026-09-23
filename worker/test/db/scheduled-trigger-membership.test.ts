import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import { PrismaClient } from '@prisma/client'
import { buildNextScheduledRunAt } from '@nessie/runtime'

import { sweepDueScheduledTriggers } from '../../src/control/trigger-scheduler.js'
import {
  revalidateScheduledTriggerRunAdmission,
} from '../../src/run/execute/scheduled-trigger-admission.js'
import type { RunContext } from '../../src/run/execute/types.js'
import { assertGlobalQueuesQuiet } from './support.js'

const runDatabaseTest = process.env.DATABASE_URL ? test : test.skip

type Seed = {
  agentId: string
  channelId: string
  config: Record<string, unknown>
  organizationId: string
  scheduledFor: Date
  threadId: string
  triggerId: string
  userId?: string
}

const seedSchedule = async (
  prisma: PrismaClient,
  input: {
    nextRunAt?: Date
    skipWhenEmpty?: boolean
    userOwned?: boolean
  } = {},
): Promise<Seed> => {
  const suffix = randomUUID()
  const organization = await prisma.organization.create({
    data: { name: `scheduled membership ${suffix}` },
  })
  const project = await prisma.project.create({
    data: { name: 'p', organizationId: organization.id },
  })
  const team = await prisma.team.create({
    data: { name: 't', projectId: project.id },
  })
  const channel = await prisma.channel.create({
    data: {
      label: 'public',
      organizationId: organization.id,
      projectId: project.id,
      slug: `public-${suffix}`,
      teamId: team.id,
      visibility: 'public',
    },
  })
  const thread = await prisma.thread.create({
    data: { channelId: channel.id },
  })
  const user = input.userOwned
    ? await prisma.user.create({
        data: {
          displayName: 'Scheduled user',
          email: `scheduled-${suffix}@example.test`,
        },
      })
    : null
  if (user) {
    await prisma.organizationMember.create({
      data: { organizationId: organization.id, userId: user.id },
    })
    await prisma.teamMember.create({
      data: { teamId: team.id, userId: user.id },
    })
    await prisma.channelMember.create({
      data: { channelId: channel.id, userId: user.id },
    })
  }
  const agent = await prisma.agent.create({
    data: {
      agentKind: 'shared',
      name: 'A',
      organizationId: organization.id,
      projectId: project.id,
      teamId: team.id,
    },
  })
  await prisma.agentBinding.create({
    data: { agentId: agent.id, channelId: channel.id },
  })
  const config: Record<string, unknown> = user
    ? {
        createdByUserId: user.id,
        interval_minutes: 10_080,
        launchOrigin: {
          organizationId: organization.id,
          projectId: project.id,
          teamId: team.id,
          userId: user.id,
        },
      }
    : {
        createdViaTool: true,
        interval_minutes: 10_080,
        ...(input.skipWhenEmpty ? { skipWhenEmpty: true } : {}),
      }
  const scheduledFor = input.nextRunAt
    ?? new Date(Date.now() - 120_000)
  const trigger = await prisma.agentTrigger.create({
    data: {
      agentId: agent.id,
      config,
      nextRunAt: scheduledFor,
      targetChannelId: channel.id,
      targetThreadId: thread.id,
      type: 'interval',
    },
  })
  return {
    agentId: agent.id,
    channelId: channel.id,
    config,
    organizationId: organization.id,
    scheduledFor,
    threadId: thread.id,
    triggerId: trigger.id,
    ...(user ? { userId: user.id } : {}),
  }
}

const cleanup = async (prisma: PrismaClient, seed: Seed): Promise<void> => {
  await prisma.$executeRawUnsafe(
    'DELETE FROM queue_jobs WHERE payload->>\'triggerId\' = $2::text OR '
    + 'payload->>\'threadId\' IN '
    + '(SELECT id::text FROM threads WHERE channel_id = $1::uuid)',
    seed.channelId,
    seed.triggerId,
  )
  await prisma.organization.delete({ where: { id: seed.organizationId } })
  if (seed.userId) await prisma.user.delete({ where: { id: seed.userId } })
}

runDatabaseTest('a quiet schedule stops when its shared agent leaves the channel', async () => {
  const prisma = new PrismaClient()
  await assertGlobalQueuesQuiet(prisma)
  const now = new Date()
  const seed = await seedSchedule(prisma, { skipWhenEmpty: true })

  try {
    await prisma.agentBinding.deleteMany({
      where: { agentId: seed.agentId, channelId: seed.channelId },
    })
    await sweepDueScheduledTriggers(prisma, { limit: 10, now })

    const trigger = await prisma.agentTrigger.findUniqueOrThrow({
      where: { id: seed.triggerId },
      select: {
        enabled: true,
        healthReason: true,
        lastFiredAt: true,
        nextRunAt: true,
        status: true,
      },
    })
    assert.equal(trigger.enabled, false)
    assert.equal(trigger.status, 'error')
    assert.equal(trigger.healthReason, 'agent_channel_access_lost')
    assert.equal(trigger.lastFiredAt, null)
    assert.equal(
      trigger.nextRunAt?.toISOString(),
      buildNextScheduledRunAt({
        config: seed.config,
        from: seed.scheduledFor,
        now,
        type: 'interval',
      })?.toISOString(),
    )
    const delivery = await prisma.agentTriggerDelivery.findFirstOrThrow({
      where: { triggerId: seed.triggerId },
      select: { nextRetryAt: true, status: true },
    })
    assert.equal(delivery.status, 'failed')
    assert.equal(delivery.nextRetryAt, null)
    assert.equal(await prisma.run.count({ where: { triggerId: seed.triggerId } }), 0)
    assert.equal(
      await prisma.message.count({ where: { threadId: seed.threadId } }),
      0,
      'membership admission must run before the empty-work check can skip',
    )
  } finally {
    await cleanup(prisma, seed)
    await prisma.$disconnect()
  }
})

runDatabaseTest('a delivered occurrence is never rewritten after removal', async () => {
  const prisma = new PrismaClient()
  await assertGlobalQueuesQuiet(prisma)
  const now = new Date()
  const seed = await seedSchedule(prisma)
  const delivery = await prisma.agentTriggerDelivery.create({
    data: {
      dedupeKey: `scheduled:${seed.triggerId}:${seed.scheduledFor.toISOString()}`,
      deliveredAt: new Date(),
      source: 'scheduler',
      status: 'delivered',
      triggerId: seed.triggerId,
    },
  })

  try {
    await prisma.agentBinding.deleteMany({
      where: { agentId: seed.agentId, channelId: seed.channelId },
    })
    await sweepDueScheduledTriggers(prisma, { limit: 10, now })

    const settledDelivery = await prisma.agentTriggerDelivery.findUniqueOrThrow({
      where: { id: delivery.id },
      select: { status: true },
    })
    assert.equal(settledDelivery.status, 'delivered')
    const trigger = await prisma.agentTrigger.findUniqueOrThrow({
      where: { id: seed.triggerId },
      select: { healthReason: true, status: true },
    })
    assert.equal(trigger.status, 'active')
    assert.equal(trigger.healthReason, null)
  } finally {
    await cleanup(prisma, seed)
    await prisma.$disconnect()
  }
})

runDatabaseTest('queued scheduled work rechecks membership before execution', async () => {
  const prisma = new PrismaClient()
  await assertGlobalQueuesQuiet(prisma)
  const seed = await seedSchedule(prisma, {
    nextRunAt: new Date(Date.now() + 3_600_000),
  })

  try {
    const delivery = await prisma.agentTriggerDelivery.create({
      data: { status: 'delivered', triggerId: seed.triggerId },
    })
    await prisma.agentBinding.deleteMany({
      where: { agentId: seed.agentId, channelId: seed.channelId },
    })

    const result = await revalidateScheduledTriggerRunAdmission(
      prisma,
      {
        agent: { id: seed.agentId },
        run: {
          id: randomUUID(),
          threadId: seed.threadId,
          triggerDeliveryId: delivery.id,
          triggerId: seed.triggerId,
        },
      } as RunContext,
    )

    assert.equal(result, 'cancelled')
    const trigger = await prisma.agentTrigger.findUniqueOrThrow({
      where: { id: seed.triggerId },
      select: { healthReason: true, status: true },
    })
    assert.equal(trigger.status, 'error')
    assert.equal(trigger.healthReason, 'agent_channel_access_lost')
    const failed = await prisma.agentTriggerDelivery.findUniqueOrThrow({
      where: { id: delivery.id },
      select: { nextRetryAt: true, status: true },
    })
    assert.equal(failed.status, 'failed')
    assert.equal(failed.nextRetryAt, null)
  } finally {
    await cleanup(prisma, seed)
    await prisma.$disconnect()
  }
})

runDatabaseTest('a public-channel schedule stops after its user leaves', async () => {
  const prisma = new PrismaClient()
  await assertGlobalQueuesQuiet(prisma)
  const now = new Date()
  const seed = await seedSchedule(prisma, { userOwned: true })
  assert.ok(seed.userId)

  try {
    await prisma.channelMember.deleteMany({
      where: { channelId: seed.channelId, userId: seed.userId },
    })
    await sweepDueScheduledTriggers(prisma, { limit: 10, now })

    const stopped = await prisma.agentTrigger.findUniqueOrThrow({
      where: { id: seed.triggerId },
      select: { enabled: true, healthReason: true, lastFiredAt: true, status: true },
    })
    assert.equal(stopped.enabled, false)
    assert.equal(stopped.status, 'error')
    assert.equal(stopped.healthReason, 'channel_access_lost')
    assert.equal(stopped.lastFiredAt, null)
    assert.equal(await prisma.run.count({ where: { triggerId: seed.triggerId } }), 0)
    const delivery = await prisma.agentTriggerDelivery.findFirstOrThrow({
      where: { triggerId: seed.triggerId },
      select: { nextRetryAt: true, status: true },
    })
    assert.equal(delivery.status, 'failed')
    assert.equal(delivery.nextRetryAt, null)
  } finally {
    await cleanup(prisma, seed)
    await prisma.$disconnect()
  }
})
