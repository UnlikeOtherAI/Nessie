import assert from 'node:assert/strict'
import test from 'node:test'

import type { RateLimitDecision, RateLimitRule } from '../src/services/rate-limit.js'

/**
 * Unit coverage for the Postgres-backed auth brute-force limiter (issue #211)
 * using an in-memory fake of the `$queryRaw` upsert-increment store. Route-level
 * behaviour (429 + Retry-After, proxy trust, /health exemption) is covered in
 * auth-rate-limit-routes.test.ts.
 */

type BucketRow = { count: number }

class FakeRateLimitStore {
  readonly rows = new Map<string, BucketRow>()
  failNext = false

  readonly prisma = {
    $queryRaw: async (
      strings: TemplateStringsArray,
      ...values: unknown[]
    ): Promise<Array<{ count: number }>> => {
      if (this.failNext) {
        this.failNext = false
        throw new Error('simulated store outage')
      }
      const query = strings.join('?')
      assert.ok(
        query.includes('INSERT INTO "rate_limit_buckets"'),
        `unexpected $queryRaw query: ${query}`,
      )
      // Positional args: id, bucket, keyHash, windowStart, ...
      const bucket = String(values[1])
      const keyHash = String(values[2])
      const windowStart = (values[3] as Date).toISOString()
      const key = `${bucket}|${keyHash}|${windowStart}`
      const row = this.rows.get(key) ?? { count: 0 }
      row.count += 1
      this.rows.set(key, row)
      return [{ count: row.count }]
    },
    $executeRaw: async (): Promise<number> => 0,
  }
}

const noopLogger = { error: () => {} }

const createLimiter = async (store: FakeRateLimitStore) => {
  const { RateLimiter } = await import('../src/services/rate-limit.js')
  return new RateLimiter(store.prisma as never, noopLogger)
}

const RULE: RateLimitRule = { max: 3, windowMs: 60_000 }

test('fixed-window counter trips at max + 1 with a bounded retry-after', async () => {
  const store = new FakeRateLimitStore()
  const limiter = await createLimiter(store)

  const decisions: RateLimitDecision[] = []
  for (let i = 0; i < 4; i += 1) {
    decisions.push(await limiter.check('test.bucket', RULE, 'ip:203.0.113.7'))
  }

  assert.deepEqual(
    decisions.map((decision) => decision.limited),
    [false, false, false, true],
  )
  const tripped = decisions[3]!
  assert.equal(tripped.bucket, 'test.bucket')
  assert.equal(tripped.count, 4)
  assert.equal(tripped.limit, 3)
  assert.ok(tripped.retryAfterSeconds >= 1)
  assert.ok(tripped.retryAfterSeconds <= 60)

  const snapshot = limiter.snapshot()
  assert.equal(snapshot.checks, 4)
  assert.equal(snapshot.limited, 1)
  assert.equal(snapshot.storeErrors, 0)
  assert.equal(snapshot.limitedByBucket['test.bucket'], 1)
})

test('buckets and identities are independent counters', async () => {
  const store = new FakeRateLimitStore()
  const limiter = await createLimiter(store)

  for (let i = 0; i < 3; i += 1) {
    await limiter.check('test.bucket', RULE, 'ip:203.0.113.7')
  }
  // Same identity, different bucket: fresh counter.
  assert.equal(
    (await limiter.check('other.bucket', RULE, 'ip:203.0.113.7')).limited,
    false,
  )
  // Same bucket, different identity: fresh counter.
  assert.equal(
    (await limiter.check('test.bucket', RULE, 'ip:203.0.113.8')).limited,
    false,
  )
  // The original counter still trips on its next hit.
  assert.equal(
    (await limiter.check('test.bucket', RULE, 'ip:203.0.113.7')).limited,
    true,
  )
})

test('guard counts IP and account independently and rejects when either trips', async () => {
  const store = new FakeRateLimitStore()
  const limiter = await createLimiter(store)
  const rules = {
    ip: { bucket: 'test.guard.ip', rule: { max: 2, windowMs: 60_000 } },
    account: { bucket: 'test.guard.account', rule: { max: 5, windowMs: 60_000 } },
  }

  // Trip the per-IP counter (max 2) while the account counter stays under.
  assert.equal(
    (await limiter.guard({ rules, ip: '198.51.100.1', accountIdentity: 'user-1' })).allowed,
    true,
  )
  assert.equal(
    (await limiter.guard({ rules, ip: '198.51.100.1', accountIdentity: 'user-1' })).allowed,
    true,
  )
  const limited = await limiter.guard({
    rules,
    ip: '198.51.100.1',
    accountIdentity: 'user-1',
  })
  assert.equal(limited.allowed, false)
  if (limited.allowed) return
  assert.ok(limited.retryAfterSeconds >= 1)

  // A different IP with the SAME account is unaffected (account max is 5,
  // and only three hits have landed on it so far).
  assert.equal(
    (await limiter.guard({ rules, ip: '198.51.100.2', accountIdentity: 'user-1' })).allowed,
    true,
  )
})

test('the store fails open: a store error allows the request and logs loudly', async () => {
  const store = new FakeRateLimitStore()
  const { RateLimiter } = await import('../src/services/rate-limit.js')
  const errors: unknown[] = []
  const limiter = new RateLimiter(store.prisma as never, {
    error: (msg) => errors.push(msg),
  })

  store.failNext = true
  const decision = await limiter.check('test.bucket', RULE, 'ip:203.0.113.7')
  assert.equal(decision.limited, false)
  assert.equal(limiter.snapshot().storeErrors, 1)
  assert.equal(errors.length, 1)
  assert.match(String(errors[0]), /FAIL-OPEN/)

  store.failNext = true
  const result = await limiter.guard({
    rules: { ip: { bucket: 'test.bucket', rule: RULE } },
    ip: '203.0.113.7',
  })
  assert.equal(result.allowed, true)
})
