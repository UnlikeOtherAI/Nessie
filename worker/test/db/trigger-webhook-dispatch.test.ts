import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

import { PrismaClient } from '@prisma/client'

import { dispatchWebhookTrigger } from '../../src/control/trigger-webhook.js'
import { deleteThreadQueueJobs, runDatabaseTest } from './support.js'

/**
 * `trigger.webhook.dispatch` is safe to replay, and it is where the delivery
 * row is now written (audit 9.2, docs/standards/horizontal-scaling.md § 3).
 *
 * The intake route enqueues and acks; the fire lands here. Two things have to
 * hold. The received bytes reach `agent_trigger_deliveries` unchanged — the
 * property the inline path was pinned on, which moved with the work. And the
 * job is replay-safe, because the queue is at-least-once: a dropped ack or a
 * lease expiry hands the same job to a second worker, and a trigger fire that
 * ran twice is two runs and two agent turns in someone's channel.
 */

type Seed = {
  agentId: string
  channelId: string
  organizationId: string
  threadId: string
  triggerId: string
}

const seed = async (prisma: PrismaClient): Promise<Seed> => {
  const suffix = randomUUID()
  const organization = await prisma.organization.create({ data: { name: `trg-wh ${suffix}` } })
  const project = await prisma.project.create({
    data: { name: `project-${suffix}`, organizationId: organization.id },
  })
  const team = await prisma.team.create({
    data: { name: `team-${suffix}`, projectId: project.id },
  })
  const channel = await prisma.channel.create({
    data: {
      label: 'Builds',
      organizationId: organization.id,
      projectId: project.id,
      slug: `builds-${suffix}`,
      teamId: team.id,
    },
  })
  const thread = await prisma.thread.create({ data: { channelId: channel.id } })
  const agent = await prisma.agent.create({
    data: {
      name: 'Release watcher',
      organizationId: organization.id,
      projectId: project.id,
      teamId: team.id,
    },
  })
  await prisma.agentBinding.create({ data: { agentId: agent.id, channelId: channel.id } })
  const trigger = await prisma.agentTrigger.create({
    data: {
      agentId: agent.id,
      config: { apiKey: `ntk_${suffix.replace(/-/g, '')}` },
      targetChannelId: channel.id,
      targetThreadId: thread.id,
      type: 'webhook',
    },
  })

  return {
    agentId: agent.id,
    channelId: channel.id,
    organizationId: organization.id,
    threadId: thread.id,
    triggerId: trigger.id,
  }
}

runDatabaseTest('replaying a webhook dispatch fires the trigger once', async () => {
  const prisma = new PrismaClient()
  const context = await seed(prisma)
  const dedupeKey = `dlv-${randomUUID()}`
  const payload = { build: { id: 'build-42', state: 'passed' }, labels: ['release', 'eu'] }
  const job = { dedupeKey, payload, triggerId: context.triggerId }

  try {
    await dispatchWebhookTrigger(prisma, job)

    const deliveries = await prisma.agentTriggerDelivery.findMany({
      where: { triggerId: context.triggerId },
      select: { dedupeKey: true, payload: true, source: true, status: true },
    })
    assert.equal(deliveries.length, 1, 'the fire is recorded once')
    assert.equal(deliveries[0]?.source, 'webhook')
    assert.equal(deliveries[0]?.status, 'delivered')
    assert.equal(
      deliveries[0]?.dedupeKey,
      `webhook:${dedupeKey}`,
      'the sender’s delivery id is the delivery key, in the namespace it always had',
    )
    assert.deepEqual(
      deliveries[0]?.payload,
      payload,
      'the exact bytes the sender posted reach the delivery row',
    )

    const runs = await prisma.run.findMany({ where: { triggerId: context.triggerId } })
    assert.equal(runs.length, 1, 'one fire is one run')

    // The job is claimed a second time — a dropped ack, a lease expiry, a nack.
    await dispatchWebhookTrigger(prisma, job)

    assert.equal(
      await prisma.agentTriggerDelivery.count({ where: { triggerId: context.triggerId } }),
      1,
      'the replay adds no second delivery',
    )
    assert.equal(
      await prisma.run.count({ where: { triggerId: context.triggerId } }),
      1,
      'and no second run',
    )
    assert.equal(
      await prisma.message.count({ where: { threadId: context.threadId } }),
      1,
      'and no second kickoff message in the channel',
    )
  } finally {
    await deleteThreadQueueJobs(prisma, context.threadId)
    await prisma.organization.delete({ where: { id: context.organizationId } })
    await prisma.$disconnect()
  }
})

runDatabaseTest('a trigger paused between the ack and the claim does not fire', async () => {
  const prisma = new PrismaClient()
  const context = await seed(prisma)

  try {
    // The receiver's 202 is an acceptance, not a promise: state can change
    // before the job is claimed, so the handler re-checks rather than trusting
    // the readiness the route resolved.
    await prisma.agentTrigger.update({
      where: { id: context.triggerId },
      data: { status: 'paused' },
    })

    await dispatchWebhookTrigger(prisma, {
      dedupeKey: `dlv-${randomUUID()}`,
      payload: { event: 'ping' },
      triggerId: context.triggerId,
    })

    assert.equal(
      await prisma.agentTriggerDelivery.count({ where: { triggerId: context.triggerId } }),
      0,
      'a paused trigger records no delivery',
    )
    assert.equal(
      await prisma.run.count({ where: { triggerId: context.triggerId } }),
      0,
      'and starts no run',
    )
  } finally {
    await deleteThreadQueueJobs(prisma, context.threadId)
    await prisma.organization.delete({ where: { id: context.organizationId } })
    await prisma.$disconnect()
  }
})
