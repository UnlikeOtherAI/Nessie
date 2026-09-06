import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import test from 'node:test'

import { PrismaClient } from '@prisma/client'
import Fastify from 'fastify'

import { registerBoardSourceAdaptersFromEnv } from '@nessie/board-source-providers'

import { registerBoardSourceWebhookRoutes } from '../src/routes/board-sources/webhooks.js'
import type { RouteDeps } from '../src/routes/types.js'

/**
 * The intake route is the only place a provider retry can be collapsed.
 *
 * `applyInboundItem` serialises two appliers of one item, but two jobs still
 * mean two full re-reads of the provider's API and two chances to interleave,
 * so the enqueue carries the delivery id as its idempotency key — and where a
 * provider gives none, a hash of the body it re-sent (audit 9.1,
 * docs/standards/horizontal-scaling.md § 3).
 *
 * DB-backed because the coalescing lives in `queue_jobs`' unique index on
 * `idempotency_key`: a stub would only prove we passed an argument. Every
 * assertion names an exact key, because this database is shared and a prefix
 * count would be a global count.
 */
const runDatabaseTest = process.env.DATABASE_URL ? test : test.skip

const buildApp = async (prisma: PrismaClient) => {
  const app = Fastify()
  registerBoardSourceWebhookRoutes(app, { prisma } as unknown as RouteDeps)
  await app.ready()
  return app
}

const jobsWithKey = (prisma: PrismaClient, key: string) =>
  prisma.queueJob.count({ where: { idempotencyKey: key } })

runDatabaseTest('a redelivered webhook with the same delivery id is one job', async () => {
  // Linear registers unconditionally — its adapter always offers a personal
  // API key — so this exercises the real `parseWebhook`, not a stand-in.
  registerBoardSourceAdaptersFromEnv({})
  const prisma = new PrismaClient()
  const app = await buildApp(prisma)
  const suffix = randomUUID()
  const [tokenA, tokenB] = [`a-${suffix}`, `b-${suffix}`]
  const webhookId = `wh-${suffix}`
  const payload = {
    action: 'update',
    webhookId,
    webhookTimestamp: 1_757_000_000_000,
    data: { id: 'issue-1', teamId: 'team-1' },
  }
  const delivery = `${webhookId}:issue-1:1757000000000`
  const keyA = `board-source-webhook:linear:${tokenA}:${delivery}`
  const keyB = `board-source-webhook:linear:${tokenB}:${delivery}`
  try {
    for (const attempt of [1, 2, 3]) {
      const response = await app.inject({
        method: 'POST',
        url: `/api/board-sources/webhooks/linear/${tokenA}`,
        payload,
      })
      assert.equal(response.statusCode, 202, `attempt ${attempt}`)
    }

    assert.equal(
      await jobsWithKey(prisma, keyA),
      1,
      'three deliveries of one webhook are one job, keyed on the provider’s own '
        + 'delivery identity rather than a clock reading',
    )

    // The same action delivered to a *second* source's callback must still
    // enqueue: Trello sends one action id to every webhook watching a board,
    // and only the token says which source can verify it.
    const scoped = await app.inject({
      method: 'POST',
      url: `/api/board-sources/webhooks/linear/${tokenB}`,
      payload,
    })
    assert.equal(scoped.statusCode, 202)
    assert.equal(await jobsWithKey(prisma, keyB), 1, 'a second callback token is a second job')
  } finally {
    await prisma.queueJob.deleteMany({ where: { idempotencyKey: { in: [keyA, keyB] } } })
    await app.close()
    await prisma.$disconnect()
  }
})

runDatabaseTest('a provider with no delivery id falls back to the body hash', async () => {
  const prisma = new PrismaClient()
  const app = await buildApp(prisma)
  const token = `site-${randomUUID()}`
  // Jira sends no delivery id at all, so the bytes it re-sent are the identity.
  const payload = {
    webhookEvent: 'jira:issue_updated',
    timestamp: 1_757_000_000_000,
    issue: { id: randomUUID() },
  }
  const later = { ...payload, timestamp: 1_757_000_000_001 }
  const keyFor = (body: unknown) =>
    `board-source-webhook:jira:${token}:body:${
      createHash('sha256').update(JSON.stringify(body)).digest('hex')
    }`
  try {
    for (const attempt of [1, 2]) {
      const response = await app.inject({
        method: 'POST',
        url: `/api/board-sources/webhooks/jira/${token}`,
        payload,
      })
      assert.equal(response.statusCode, 202, `attempt ${attempt}`)
    }
    assert.equal(await jobsWithKey(prisma, keyFor(payload)), 1, 'a repeated body is one delivery')

    // A genuinely different event on the same source is a different job.
    const other = await app.inject({
      method: 'POST',
      url: `/api/board-sources/webhooks/jira/${token}`,
      payload: later,
    })
    assert.equal(other.statusCode, 202)
    assert.equal(await jobsWithKey(prisma, keyFor(later)), 1)
  } finally {
    await prisma.queueJob.deleteMany({
      where: { idempotencyKey: { in: [keyFor(payload), keyFor(later)] } },
    })
    await app.close()
    await prisma.$disconnect()
  }
})
