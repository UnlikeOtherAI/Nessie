import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import { PrismaClient } from '@prisma/client'
import Fastify, { type FastifyRequest } from 'fastify'

import { registerTriggerIntakeRoutes } from '../src/routes/trigger-intake.js'
import { mapTriggerDeliveryRecord } from '../src/services/trigger-shared.js'
import type { RouteDeps } from '../src/routes/types.js'

/**
 * `POST /api/triggers/webhook` enqueues and acks (audit 9.2,
 * docs/standards/horizontal-scaling.md § 3).
 *
 * It used to dispatch inline: the sender waited out a launch-origin preflight,
 * a UOA identity check and a six-write transaction, and an instance recycled
 * part-way through lost a delivery it had already answered 2xx for. What must
 * NOT have moved is the sender's answer to "is this trigger usable" — an agent
 * bound to no channel is still a 409, and a 409 must queue nothing.
 *
 * DB-backed, because both properties under test live in Postgres: the
 * collapsing is `queue_jobs`' unique index on `idempotency_key`, and the
 * readiness answer is a join across the trigger, its thread and its binding. A
 * stub would only prove an argument was passed. Every query is scoped to this
 * seed's own trigger — `queue_jobs` is global, so a prefix count would be a
 * global count — and scoped by what the *payload* names rather than by the
 * idempotency key, since the key is the thing under test.
 */
const runDatabaseTest = process.env.DATABASE_URL ? test : test.skip

const WEBHOOK_TOPIC = 'trigger.webhook.dispatch'

type Seed = {
  channelId: string
  organizationId: string
  triggerId: string
  webhookKey: string
}

const seedWebhookTrigger = async (
  prisma: PrismaClient,
  options: { bind: boolean },
): Promise<Seed> => {
  const suffix = randomUUID()
  const webhookKey = `ntk_${suffix.replace(/-/g, '')}`
  const org = await prisma.organization.create({ data: { name: `trg-enq ${suffix}` } })
  const project = await prisma.project.create({
    data: { name: 'p', organizationId: org.id },
  })
  const team = await prisma.team.create({ data: { name: 't', projectId: project.id } })
  const channel = await prisma.channel.create({
    data: {
      label: 'c',
      slug: `c-${suffix}`,
      organizationId: org.id,
      projectId: project.id,
      teamId: team.id,
    },
  })
  const thread = await prisma.thread.create({ data: { channelId: channel.id } })
  const agent = await prisma.agent.create({ data: { name: 'A', organizationId: org.id } })
  if (options.bind) {
    await prisma.agentBinding.create({ data: { agentId: agent.id, channelId: channel.id } })
  }
  const trigger = await prisma.agentTrigger.create({
    data: {
      agentId: agent.id,
      config: { apiKey: webhookKey },
      targetChannelId: channel.id,
      targetThreadId: thread.id,
      type: 'webhook',
    },
  })

  return {
    channelId: channel.id,
    organizationId: org.id,
    triggerId: trigger.id,
    webhookKey,
  }
}

/**
 * This trigger's queued jobs, found by what the payload names rather than by the
 * idempotency key — the key is the thing under test.
 */
const jobsForTrigger = (triggerId: string) => ({
  payload: { path: ['triggerId'], equals: triggerId },
  topic: WEBHOOK_TOPIC,
})

const cleanup = async (prisma: PrismaClient, seed: Seed): Promise<void> => {
  // Keyed on this trigger alone: `queue_jobs` is global, and a prefix-matched
  // delete would take rows a concurrent suite is about to count.
  await prisma.queueJob.deleteMany({ where: jobsForTrigger(seed.triggerId) })
  await prisma.organization.delete({ where: { id: seed.organizationId } })
}

const parseHeaderValue = (value: string | string[] | undefined): string | undefined => {
  const first = Array.isArray(value) ? value[0] : value
  const trimmed = first?.trim()
  return trimmed ? trimmed : undefined
}

const createIntakeApp = async (prisma: PrismaClient) => {
  const app = Fastify()
  registerTriggerIntakeRoutes(app, {
    isJsonContentType: () => true,
    prisma,
    readFirstHeader: (request: FastifyRequest, names: string[]) => {
      for (const name of names) {
        const value = parseHeaderValue(request.headers[name])
        if (value) return value
      }
      return undefined
    },
    readWebhookApiKey: (request: FastifyRequest) => {
      const authorization = parseHeaderValue(request.headers.authorization)
      return authorization?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim()
    },
    requireActorContext: () => null,
    requireOwner: () => false,
  } as unknown as RouteDeps)
  await app.ready()
  return app
}

runDatabaseTest('a webhook delivery is one queued job, and a redelivery is still one', async () => {
  const prisma = new PrismaClient()
  const seed = await seedWebhookTrigger(prisma, { bind: true })
  const app = await createIntakeApp(prisma)
  const deliveryId = `dlv-${randomUUID()}`
  const key = `trigger-webhook:${seed.triggerId}:${deliveryId}`
  const body = { build: { id: 'build-42', state: 'passed' }, labels: ['release', 'eu'] }

  try {
    const first = await app.inject({
      headers: {
        authorization: `Bearer ${seed.webhookKey}`,
        'content-type': 'application/json',
        'x-nessie-delivery-id': deliveryId,
      },
      method: 'POST',
      payload: body,
      url: '/api/triggers/webhook',
    })

    assert.equal(first.statusCode, 202)
    const firstBody = first.json() as {
      data: { accepted: boolean; dedupeKey: string; existing: boolean; triggerId: string }
    }
    assert.deepEqual(firstBody.data, {
      accepted: true,
      dedupeKey: deliveryId,
      existing: false,
      triggerId: seed.triggerId,
    })

    // Scoped by the trigger the payload names, not by the idempotency key: the
    // key is what is under test, so a count that used it as its filter could
    // not tell "collapsed into one job" from "keyed somewhere else".
    const jobs = await prisma.queueJob.findMany({ where: jobsForTrigger(seed.triggerId) })
    assert.equal(jobs.length, 1, 'one delivery is one job')
    assert.equal(jobs[0]?.topic, WEBHOOK_TOPIC)
    assert.deepEqual(
      jobs[0]?.payload,
      { dedupeKey: deliveryId, payload: body, triggerId: seed.triggerId },
      'the job carries the exact bytes the sender posted',
    )

    // The fire is the worker's: nothing about the run exists yet.
    assert.equal(
      await prisma.agentTriggerDelivery.count({ where: { triggerId: seed.triggerId } }),
      0,
      'the delivery row is written by the handler, not by the request',
    )
    assert.equal(
      await prisma.run.count({ where: { triggerId: seed.triggerId } }),
      0,
      'no run is created on the request path',
    )

    // The provider retries the same delivery.
    const second = await app.inject({
      headers: {
        authorization: `Bearer ${seed.webhookKey}`,
        'content-type': 'application/json',
        'x-nessie-delivery-id': deliveryId,
      },
      method: 'POST',
      payload: body,
      url: '/api/triggers/webhook',
    })

    assert.equal(second.statusCode, 202)
    assert.equal(
      await prisma.queueJob.count({ where: jobsForTrigger(seed.triggerId) }),
      1,
      'a redelivery collapses into the job already queued',
    )
    assert.equal(
      (second.json() as { data: { existing: boolean } }).data.existing,
      true,
      'the sender is told this delivery was already accepted',
    )
    assert.equal(
      jobs[0]?.idempotencyKey,
      key,
      'and it collapsed because the sender’s own delivery id is the key',
    )
  } finally {
    await app.close()
    await cleanup(prisma, seed)
    await prisma.$disconnect()
  }
})

runDatabaseTest('an unusable trigger is refused synchronously and queues nothing', async () => {
  const prisma = new PrismaClient()
  // Same trigger, with the agent bound to no channel — the misconfiguration a
  // sender has to hear about on the delivery it sent.
  const seed = await seedWebhookTrigger(prisma, { bind: false })
  const app = await createIntakeApp(prisma)
  const deliveryId = `dlv-${randomUUID()}`

  try {
    const unbound = await app.inject({
      headers: {
        authorization: `Bearer ${seed.webhookKey}`,
        'content-type': 'application/json',
        'x-nessie-delivery-id': deliveryId,
      },
      method: 'POST',
      payload: { event: 'ping' },
      url: '/api/triggers/webhook',
    })

    assert.equal(unbound.statusCode, 409)
    assert.equal(unbound.json().error.code, 'AGENT_NOT_BOUND')

    // A paused trigger is the other refusal, and it must not queue either.
    await prisma.agentTrigger.update({
      where: { id: seed.triggerId },
      data: { status: 'paused' },
    })
    const paused = await app.inject({
      headers: {
        authorization: `Bearer ${seed.webhookKey}`,
        'content-type': 'application/json',
        'x-nessie-delivery-id': `${deliveryId}-paused`,
      },
      method: 'POST',
      payload: { event: 'ping' },
      url: '/api/triggers/webhook',
    })
    assert.equal(paused.statusCode, 409)
    assert.equal(paused.json().error.code, 'TRIGGER_UNAVAILABLE')

    assert.equal(
      await prisma.queueJob.count({ where: jobsForTrigger(seed.triggerId) }),
      0,
      'a refused delivery is never queued',
    )
  } finally {
    await app.close()
    await cleanup(prisma, seed)
    await prisma.$disconnect()
  }
})

/**
 * The other end of the handle the 202 hands out.
 *
 * The ack returns a bare `dedupeKey` and calls it the key
 * `GET /api/triggers/:id/deliveries` reports for that fire. The worker stores it
 * namespaced (`webhook:<key>`) so a caller can never occupy the scheduler's
 * predictable key, and a claim-time refusal writes it as a terminal `skipped`
 * row rather than nothing at all. Both halves have to meet: what the endpoint
 * reports back must be the string the sender was given, and it must say why
 * nothing ran. No database — this is the mapping, and the mapping is the promise.
 */
test('a skipped delivery is reported under the exact key the ack returned', () => {
  const ackedKey = 'dlv-8f2c'

  const reported = mapTriggerDeliveryRecord({
    createdAt: new Date('2026-09-06T10:00:00.000Z'),
    dedupeKey: `webhook:${ackedKey}`,
    deliveredAt: null,
    errorMessage: 'trigger_paused',
    id: '2f1c4a5e-0000-4000-8000-000000000001',
    payload: { event: 'ping' },
    run: null,
    source: 'webhook',
    status: 'skipped',
    triggerId: '2f1c4a5e-0000-4000-8000-000000000002',
  })

  assert.equal(reported.dedupeKey, ackedKey, 'the sender looks it up by the key it was given')
  assert.equal(reported.status, 'skipped')
  assert.equal(
    reported.errorMessage,
    'trigger_paused',
    'and finds why the fire it was acked for did nothing',
  )
  assert.equal(reported.runId, undefined, 'a skip has no run to point at')
})
