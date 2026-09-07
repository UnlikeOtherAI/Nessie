import assert from 'node:assert/strict'
import test from 'node:test'

import { PrismaClient } from '@prisma/client'
import { clearRateLimitWindows } from '@nessie/db'

import { RATE_LIMIT_BUCKETS } from '../src/routes/auth-rate-limit.js'
import { getOpsHealth } from '../src/services/ops-health.js'
import { RateLimiter } from '../src/services/rate-limit.js'

/**
 * Plan row 5.9 / audit 1.13. `/api/ops/health` reported the limiter's
 * in-process counters, which on a fleet of N API replicas is one replica's
 * share of the traffic and means nothing on its own: an operator watching a
 * brute-force flood saw whatever fraction of it the load balancer happened to
 * send to the instance they were talking to.
 *
 * The deployment-wide numbers now come from `rate_limit_buckets`, which every
 * replica already increments through the shared statement in @nessie/db.
 *
 * Two RateLimiter instances stand in for two API processes: they share the
 * database and nothing else, exactly like two containers. The load is driven
 * through ONE of them and the numbers are read from the OTHER — which is the
 * whole claim, and what fails without the fix.
 *
 * Shared database, so nothing here clears a bucket another suite counts into:
 * the isolated assertions run against a bucket name unique to this suite, and
 * the one test that must go through the real configured bucket list asserts
 * lower bounds on a suite-unique identity instead of exact totals
 * (docs/standards/testing.md).
 */

const dbTest = process.env.DATABASE_URL ? test : test.skip

const organizationId = '00000000-0000-4000-8000-000000005900'

const noopLogger = { error: () => {} }

/** Not a configured limiter: nothing else in the tree counts into it. */
const OWN_BUCKET = 'test.ops_health_window.5900'
const RULE = { max: 3, windowMs: 10 * 60_000 }

// The one real bucket this suite drives, and only ever under an identity of its
// own. `executor.daemon.ip` has no other database-backed test.
const SHARED_BUCKET_NAME = 'executorDaemonIp' as const
const SHARED_BUCKET = RATE_LIMIT_BUCKETS[SHARED_BUCKET_NAME]

// `getOpsHealth` walks every name in RATE_LIMIT_BUCKETS, so the config it reads
// has to carry a rule for each. All idle but one, which is the production shape.
const configWithRules = () => ({
  api: {
    rateLimit: Object.fromEntries(
      Object.keys(RATE_LIMIT_BUCKETS).map((name) => [name, RULE]),
    ),
  },
}) as never

dbTest('a limiter reports hits counted by a DIFFERENT api instance', async () => {
  const prisma = new PrismaClient()
  // Two processes, one database. `replicaB` never calls `check`, so its own
  // in-process counters stay at zero for the whole test.
  const replicaA = new RateLimiter(prisma, noopLogger, 0)
  const replicaB = new RateLimiter(prisma, noopLogger, 0)
  try {
    await clearRateLimitWindows(prisma, OWN_BUCKET)
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await replicaA.check(OWN_BUCKET, RULE, 'ip:198.51.100.7')
    }

    const summary = await replicaB.windowSummary([{ bucket: OWN_BUCKET, rule: RULE }])

    assert.ok(summary)
    const bucket = summary[0]
    assert.ok(bucket)
    // Five attempts against a limit of three: the replica that absorbed none of
    // the flood reports all of it.
    assert.equal(bucket.bucket, OWN_BUCKET)
    assert.equal(bucket.hits, 5)
    assert.equal(bucket.identities, 1)
    assert.equal(bucket.maxCount, 5)
    assert.equal(bucket.limit, 3)
    assert.equal(bucket.limitedIdentities, 1)
    // And its own counters are honestly zero, so the two can never be confused.
    assert.equal(replicaB.snapshot().checks, 0)
  } finally {
    await clearRateLimitWindows(prisma, OWN_BUCKET).catch(() => undefined)
    await prisma.$disconnect()
  }
})

dbTest('two instances counting one identity are summed, not kept apart', async () => {
  const prisma = new PrismaClient()
  const replicaA = new RateLimiter(prisma, noopLogger, 0)
  const replicaB = new RateLimiter(prisma, noopLogger, 0)
  try {
    await clearRateLimitWindows(prisma, OWN_BUCKET)
    await replicaA.check(OWN_BUCKET, RULE, 'ip:198.51.100.8')
    await replicaB.check(OWN_BUCKET, RULE, 'ip:198.51.100.8')
    await replicaA.check(OWN_BUCKET, RULE, 'ip:198.51.100.9')

    const summary = await replicaA.windowSummary([{ bucket: OWN_BUCKET, rule: RULE }])

    const bucket = summary?.[0]
    assert.ok(bucket)
    // One identity hit twice across two replicas, another hit once: three
    // attempts, two identities, busiest count two. The per-process view had A
    // saying two-and-one and B saying one-and-one, with nothing that adds up.
    assert.equal(bucket.hits, 3)
    assert.equal(bucket.identities, 2)
    assert.equal(bucket.maxCount, 2)
    assert.equal(bucket.limitedIdentities, 0)
  } finally {
    await clearRateLimitWindows(prisma, OWN_BUCKET).catch(() => undefined)
    await prisma.$disconnect()
  }
})

dbTest('an idle window is not counted, so the summary is only live rows', async () => {
  const prisma = new PrismaClient()
  const limiter = new RateLimiter(prisma, noopLogger, 0)
  try {
    await clearRateLimitWindows(prisma, OWN_BUCKET)
    // A hit in a window that closed an hour ago must not show up in the live
    // one — the summary floors the window from the database clock per bucket.
    await limiter.check(OWN_BUCKET, RULE, 'ip:198.51.100.10')
    await prisma.$executeRaw`
      UPDATE "rate_limit_buckets"
         SET "window_start" = "window_start" - INTERVAL '1 hour'
       WHERE "bucket" = ${OWN_BUCKET}
    `

    const summary = await limiter.windowSummary([{ bucket: OWN_BUCKET, rule: RULE }])

    const bucket = summary?.[0]
    assert.ok(bucket)
    assert.equal(bucket.hits, 0)
    assert.equal(bucket.identities, 0)
  } finally {
    await clearRateLimitWindows(prisma, OWN_BUCKET).catch(() => undefined)
    await prisma.$disconnect()
  }
})

dbTest('/api/ops/health is wired to the shared counters, not to the process', async () => {
  const prisma = new PrismaClient()
  const replicaA = new RateLimiter(prisma, noopLogger, 0)
  const replicaB = new RateLimiter(prisma, noopLogger, 0)
  try {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await replicaA.check(SHARED_BUCKET, RULE, 'ip:198.51.100.59')
    }

    const health = await getOpsHealth(prisma, organizationId, replicaB, configWithRules())

    assert.equal(health.rateLimit.deploymentWide.available, true)
    assert.equal(health.rateLimit.deploymentWide.source, 'rate_limit_buckets')
    const bucket = health.rateLimit.deploymentWide.buckets.find(
      (entry) => entry.bucket === SHARED_BUCKET,
    )
    assert.ok(bucket, 'the busy bucket is listed on the endpoint')
    // Lower bounds, not equality: another suite may legitimately be counting
    // into this bucket at the same time, and that can only make these larger.
    assert.ok(bucket.hits >= 5, `expected at least 5 hits, saw ${bucket.hits}`)
    assert.ok(bucket.limitedIdentities >= 1)
    assert.equal(bucket.limit, RULE.max)
    // Every listed bucket is one that is actually counting; the idle ones are
    // left out rather than padded in as rows of zeros.
    for (const entry of health.rateLimit.deploymentWide.buckets) {
      assert.ok(entry.hits > 0, `${entry.bucket} was listed with no hits`)
    }
    // The per-process block is still reported, still separate, and on this
    // replica still zero.
    assert.equal(health.rateLimit.thisInstance.checks, 0)
    assert.equal(health.rateLimit.thisInstance.limited, 0)
    assert.equal(health.rateLimit.thisInstance.storeErrors, 0)
  } finally {
    await prisma.$disconnect()
  }
})

dbTest('a counter store that cannot be read says so instead of reporting zeros', async () => {
  const prisma = new PrismaClient()
  const broken = {
    $queryRaw: async () => {
      throw new Error('store unavailable')
    },
    $executeRaw: async () => 0,
  }
  const limiter = new RateLimiter(broken as never, noopLogger, 0)
  try {
    const health = await getOpsHealth(prisma, organizationId, limiter, configWithRules())

    // Zeros here would read as "nothing is being limited", which is a
    // measurement this endpoint did not make.
    assert.equal(health.rateLimit.deploymentWide.available, false)
    assert.deepEqual(health.rateLimit.deploymentWide.buckets, [])
  } finally {
    await prisma.$disconnect()
  }
})
