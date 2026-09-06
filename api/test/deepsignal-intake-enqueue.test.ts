import assert from 'node:assert/strict'
import { createHmac, randomUUID } from 'node:crypto'
import test from 'node:test'

import { PrismaClient } from '@prisma/client'
import Fastify from 'fastify'

import { registerRawBodyJsonParser } from '../src/lib/raw-body-json-parser.js'
import { registerExternalAgentRoutes } from '../src/routes/external-agent.js'
import type { RouteDeps } from '../src/routes/types.js'
import { setProductWebhookSecret } from '../src/services/product-webhook-secret.js'

/**
 * `POST /api/integrations/deepsignal/events` enqueues and acks (audit 9.2,
 * docs/standards/horizontal-scaling.md § 3).
 *
 * The recipient fan-out — a channel, a thread, a binding and a digest
 * transaction per linked team member — used to run inline, so one insight for a
 * fifty-person team held the request open across fifty transactions and an
 * instance recycled part-way through lost the remainder after DeepSignal had
 * been told 2xx. What stayed on the request path is everything the sender can
 * act on: the signature, the body's shape, and whether the event routes to a
 * team at all.
 *
 * DB-backed, because the collapsing is `queue_jobs`' unique index on
 * `idempotency_key` and the routing answer is a `product_team_enablements`
 * lookup joined against the team's own UOA mapping. Every query is scoped to
 * this seed's own organisation — `queue_jobs` is global, so a prefix count
 * would be a global count — and scoped by what the *payload* names rather than
 * by the idempotency key, since the key is the thing under test.
 */
const runDatabaseTest = process.env.DATABASE_URL ? test : test.skip

const AUTH_SECRET = 'deepsignal-intake-test-secret-0001'
const FANOUT_TOPIC = 'deepsignal.insight.fanout'

type Seed = {
  externalTeamId: string
  organizationId: string
  secret: string
}

const seedEnabledTeam = async (prisma: PrismaClient): Promise<Seed> => {
  const suffix = randomUUID()
  const externalOrgId = `uoa-org-${suffix}`
  const externalTeamId = `uoa-team-${suffix}`
  const secret = `ds-signing-secret-${suffix}`

  const org = await prisma.organization.create({ data: { name: `ds-enq ${suffix}` } })
  const project = await prisma.project.create({
    data: { name: 'p', organizationId: org.id },
  })
  const team = await prisma.team.create({
    data: { externalOrgId, externalTeamId, name: 't', projectId: project.id },
  })
  await prisma.productTeamEnablement.create({
    data: {
      enabled: true,
      externalOrgId,
      externalTeamId,
      organizationId: org.id,
      productSlug: 'deepsignal',
      teamId: team.id,
    },
  })
  await setProductWebhookSecret(prisma, AUTH_SECRET, {
    organizationId: org.id,
    productSlug: 'deepsignal',
    secret,
  })

  return { externalTeamId, organizationId: org.id, secret }
}

/**
 * This organisation's queued fan-outs, found by what the payload names rather
 * than by the idempotency key — the key is the thing under test.
 */
const jobsForOrg = (organizationId: string) => ({
  payload: { path: ['organizationId'], equals: organizationId },
  topic: FANOUT_TOPIC,
})

const cleanup = async (prisma: PrismaClient, seed: Seed): Promise<void> => {
  await prisma.queueJob.deleteMany({ where: jobsForOrg(seed.organizationId) })
  await prisma.productWebhookSecret.deleteMany({
    where: { organizationId: seed.organizationId },
  })
  await prisma.organization.delete({ where: { id: seed.organizationId } })
}

const createReceiverApp = async (prisma: PrismaClient) => {
  const app = Fastify()
  registerRawBodyJsonParser(app)
  registerExternalAgentRoutes(app, {
    authSecret: AUTH_SECRET,
    isJsonContentType: () => true,
    prisma,
    requireActorContext: () => null,
    requireUserActor: () => false,
  } as unknown as RouteDeps)
  await app.ready()
  return app
}

const post = (
  app: Awaited<ReturnType<typeof createReceiverApp>>,
  secret: string,
  body: unknown,
) => {
  const raw = JSON.stringify(body)
  return app.inject({
    headers: {
      'content-type': 'application/json',
      'x-deepsignal-signature': `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`,
    },
    method: 'POST',
    payload: raw,
    url: '/api/integrations/deepsignal/events',
  })
}

runDatabaseTest('a surfaced insight is one queued job, and a redelivery is still one', async () => {
  const prisma = new PrismaClient()
  const seed = await seedEnabledTeam(prisma)
  const app = await createReceiverApp(prisma)
  const insightId = `insight-${randomUUID()}`
  const key = `deepsignal-insight:${seed.organizationId}:${insightId}`
  const body = {
    event: 'insight.surfaced',
    insightId,
    teamId: seed.externalTeamId,
    brief: { whatChanged: 'A competitor changed pricing', kind: 'risk' },
  }

  try {
    const first = await post(app, seed.secret, body)
    assert.equal(first.statusCode, 202)
    assert.deepEqual(
      (first.json() as { data: unknown }).data,
      { accepted: true, existing: false, insightId },
    )

    const jobs = await prisma.queueJob.findMany({ where: jobsForOrg(seed.organizationId) })
    assert.equal(jobs.length, 1, 'one insight is one job')
    assert.equal(jobs[0]?.topic, FANOUT_TOPIC)
    assert.deepEqual(
      jobs[0]?.payload,
      { insightId, organizationId: seed.organizationId, payload: body },
      'the job carries the verified body, verbatim',
    )

    // DeepSignal retries the same event.
    const second = await post(app, seed.secret, body)
    assert.equal(second.statusCode, 202)
    assert.equal(
      await prisma.queueJob.count({ where: jobsForOrg(seed.organizationId) }),
      1,
      'a redelivery collapses into the job already queued',
    )
    assert.equal(
      (second.json() as { data: { existing: boolean } }).data.existing,
      true,
      'the sender is told this insight was already accepted',
    )
    assert.equal(
      jobs[0]?.idempotencyKey,
      key,
      'and it collapsed because the insight’s own id is the key',
    )
  } finally {
    await app.close()
    await cleanup(prisma, seed)
    await prisma.$disconnect()
  }
})

runDatabaseTest('a malformed or unroutable event is answered synchronously and queues nothing', async () => {
  const prisma = new PrismaClient()
  const seed = await seedEnabledTeam(prisma)
  const app = await createReceiverApp(prisma)

  try {
    // No insight id: the one field the receiver cannot proceed without, since it
    // is the enqueue's key and the digest's own dedupe token.
    const noId = await post(app, seed.secret, {
      event: 'insight.surfaced',
      teamId: seed.externalTeamId,
    })
    assert.equal(noId.statusCode, 400)
    assert.equal(noId.json().error.code, 'INVALID_BODY')

    // A body that is not a JSON object at all.
    const notAnObject = await post(app, seed.secret, ['insight.surfaced'])
    assert.equal(notAnObject.statusCode, 400)
    assert.equal(notAnObject.json().error.code, 'INVALID_BODY')

    // A forged signature never reaches the routing decision.
    const forged = await post(app, 'not-the-signing-secret', {
      event: 'insight.surfaced',
      insightId: `insight-${randomUUID()}`,
      teamId: seed.externalTeamId,
    })
    assert.equal(forged.statusCode, 401)

    // A team this organisation has not enabled: the caller still learns that
    // this event reaches nobody, which is what `delivered: 0` used to say.
    const unroutable = await post(app, seed.secret, {
      event: 'insight.surfaced',
      insightId: `insight-${randomUUID()}`,
      teamId: `uoa-team-${randomUUID()}`,
    })
    assert.equal(unroutable.statusCode, 200)
    assert.equal(
      (unroutable.json() as { data: { accepted: boolean; reason: string } }).data.reason,
      'team_not_enabled',
    )

    assert.equal(
      await prisma.queueJob.count({ where: jobsForOrg(seed.organizationId) }),
      0,
      'nothing the receiver refused was queued',
    )
  } finally {
    await app.close()
    await cleanup(prisma, seed)
    await prisma.$disconnect()
  }
})
