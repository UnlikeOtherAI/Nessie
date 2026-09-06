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

runDatabaseTest('a trigger paused between the ack and the claim leaves a delivery the ack’s key finds', async () => {
  const prisma = new PrismaClient()
  const context = await seed(prisma)
  // What the receiver's 202 handed the sender, and called the key
  // `GET /api/triggers/:id/deliveries` reports for this fire.
  const ackedKey = `dlv-${randomUUID()}`
  const payload = { event: 'ping' }

  try {
    // The receiver's 202 is an acceptance, not a promise: state can change
    // before the job is claimed, so the handler re-checks rather than trusting
    // the readiness the route resolved.
    await prisma.agentTrigger.update({
      where: { id: context.triggerId },
      data: { status: 'paused' },
    })

    await dispatchWebhookTrigger(prisma, {
      dedupeKey: ackedKey,
      payload,
      triggerId: context.triggerId,
    })

    const deliveries = await prisma.agentTriggerDelivery.findMany({
      where: { triggerId: context.triggerId },
      select: {
        dedupeKey: true,
        errorMessage: true,
        payload: true,
        source: true,
        status: true,
      },
    })
    // Not firing is right. Being silent about it is not: without a row the key
    // the sender holds resolves to nothing, forever, and is indistinguishable
    // from a fire still in flight — while the queue job reports success.
    assert.equal(deliveries.length, 1, 'the refused fire is still on the record')
    assert.equal(deliveries[0]?.status, 'skipped')
    assert.equal(
      deliveries[0]?.errorMessage,
      'trigger_paused',
      'and names the readiness reason the receiver’s own 409 would have carried',
    )
    assert.equal(
      deliveries[0]?.dedupeKey,
      `webhook:${ackedKey}`,
      'under exactly the key the 202 handed out (`mapTriggerDeliveryRecord` strips the source namespace)',
    )
    assert.equal(deliveries[0]?.source, 'webhook')
    assert.deepEqual(deliveries[0]?.payload, payload, 'carrying what the sender posted')

    assert.equal(
      await prisma.run.count({ where: { triggerId: context.triggerId } }),
      0,
      'and starts no run',
    )

    // A re-claimed job must not pile up skips, nor collide on the unique key.
    await dispatchWebhookTrigger(prisma, {
      dedupeKey: ackedKey,
      payload,
      triggerId: context.triggerId,
    })
    assert.equal(
      await prisma.agentTriggerDelivery.count({ where: { triggerId: context.triggerId } }),
      1,
      'the replay records the same skip once',
    )
  } finally {
    await deleteThreadQueueJobs(prisma, context.threadId)
    await prisma.organization.delete({ where: { id: context.organizationId } })
    await prisma.$disconnect()
  }
})

runDatabaseTest('an agent unbound between the ack and the claim leaves a delivery too', async () => {
  const prisma = new PrismaClient()
  const context = await seed(prisma)
  const ackedKey = `dlv-${randomUUID()}`

  try {
    // The other half of the promise: the trigger is still active, so the refusal
    // comes from `queueTriggerRun`'s own gate rather than from the handler's
    // first read. The receiver answers this one 409 AGENT_NOT_BOUND when it can
    // see it; a binding removed after the ack has to reach the operator the
    // only way left — the delivery log.
    await prisma.agentBinding.deleteMany({
      where: { agentId: context.agentId, channelId: context.channelId },
    })

    await dispatchWebhookTrigger(prisma, {
      dedupeKey: ackedKey,
      payload: { event: 'ping' },
      triggerId: context.triggerId,
    })

    const deliveries = await prisma.agentTriggerDelivery.findMany({
      where: { triggerId: context.triggerId },
      select: { dedupeKey: true, errorMessage: true, status: true },
    })
    assert.equal(deliveries.length, 1, 'the refused fire is still on the record')
    assert.equal(deliveries[0]?.status, 'skipped')
    assert.equal(deliveries[0]?.errorMessage, 'agent_not_bound')
    assert.equal(deliveries[0]?.dedupeKey, `webhook:${ackedKey}`)
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
