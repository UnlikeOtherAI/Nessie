import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import { PrismaClient } from '@prisma/client'

import {
  recordDeliveryFailure,
  retryFailedTriggerDeliveries,
} from '../../src/control/trigger-delivery-retry.js'
import { reattemptTriggerDelivery } from '../../src/control/trigger-retry-dispatch.js'

const runDatabaseTest = process.env.DATABASE_URL ? test : test.skip

runDatabaseTest('an operator pause cancels an already-recorded scheduled retry', async () => {
  const prisma = new PrismaClient()
  const suffix = randomUUID()
  const now = new Date()
  const organization = await prisma.organization.create({ data: { name: `retry pause ${suffix}` } })

  try {
    const project = await prisma.project.create({ data: { name: 'p', organizationId: organization.id } })
    const team = await prisma.team.create({ data: { name: 't', projectId: project.id } })
    const channel = await prisma.channel.create({
      data: {
        label: 'c',
        slug: `c-${suffix}`,
        organizationId: organization.id,
        projectId: project.id,
        teamId: team.id,
      },
    })
    const thread = await prisma.thread.create({ data: { channelId: channel.id } })
    const agent = await prisma.agent.create({ data: { name: 'A', organizationId: organization.id } })
    await prisma.agentBinding.create({ data: { agentId: agent.id, channelId: channel.id } })
    const trigger = await prisma.agentTrigger.create({
      data: {
        agentId: agent.id,
        config: { createdViaTool: true, interval_minutes: 10_080 },
        nextRunAt: new Date(now.getTime() + 10_080 * 60_000),
        targetChannelId: channel.id,
        targetThreadId: thread.id,
        type: 'interval',
      },
    })
    await recordDeliveryFailure(prisma, {
      dedupeKey: `scheduled:${trigger.id}:${now.toISOString()}`,
      error: new Error('transient dispatch failure'),
      payload: { scheduledFor: now.toISOString(), triggerId: trigger.id },
      retryCount: 0,
      source: 'scheduler',
      triggerId: trigger.id,
    })
    const failed = await prisma.agentTriggerDelivery.findFirstOrThrow({
      where: { triggerId: trigger.id },
      select: { id: true },
    })
    await prisma.agentTrigger.update({
      where: { id: trigger.id },
      data: { enabled: false, nextRunAt: null, status: 'paused' },
    })
    await prisma.agentTriggerDelivery.update({
      where: { id: failed.id },
      data: { nextRetryAt: new Date(Date.now() - 60_000) },
    })

    await retryFailedTriggerDeliveries(prisma, reattemptTriggerDelivery, { limit: 10 })

    const settled = await prisma.agentTriggerDelivery.findUniqueOrThrow({
      where: { id: failed.id },
      select: { nextRetryAt: true },
    })
    assert.equal(settled.nextRetryAt, null)
    assert.equal(await prisma.run.count({ where: { triggerId: trigger.id } }), 0)
  } finally {
    await prisma.organization.delete({ where: { id: organization.id } })
    await prisma.$disconnect()
  }
})
