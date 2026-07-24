import assert from 'node:assert/strict'
import { register } from 'node:module'
import test from 'node:test'

import type { RateLimitDecision, RateLimitRule } from '../src/services/rate-limit.js'

/**
 * Unit coverage for the Postgres-backed auth brute-force limiter (issue #211)
 * using an in-memory fake of the `$queryRaw` upsert-increment store and the
 * `$executeRaw` cleanup sweep. Route-level
 * behaviour (429 + Retry-After, proxy trust, /health exemption) is covered in
 * auth-rate-limit-routes.test.ts.
 */

// --- @nessie/db stub: count lockout audit writes instead of touching a DB ---
const auditWrites: Array<Record<string, unknown>> = []
;(globalThis as Record<string, unknown>).__rateLimitAuditWrites = auditWrites
const dbStub = [
  'export const writeAuditEntry = async (_prisma, entry) => {',
  '  globalThis.__rateLimitAuditWrites.push(entry)',
  '}',
].join('\n')
const dbStubUrl = `data:text/javascript,${encodeURIComponent(dbStub)}`
const dbLoader = `
export async function resolve(specifier, context, nextResolve) {
  if (specifier === '@nessie/db') {
    return { shortCircuit: true, url: ${JSON.stringify(dbStubUrl)} }
  }
  return nextResolve(specifier, context)
}
`
register(`data:text/javascript,${encodeURIComponent(dbLoader)}`, import.meta.url)

type BucketRow = { bucket: string; windowStartMs: number; count: number }

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
      const windowStart = values[3] as Date
      const key = `${bucket}|${keyHash}|${windowStart.toISOString()}`
      const row = this.rows.get(key) ?? {
        bucket,
        windowStartMs: windowStart.getTime(),
        count: 0,
      }
      row.count += 1
      this.rows.set(key, row)
      return [{ count: row.count }]
    },
    $executeRaw: async (
      strings: TemplateStringsArray,
      ...values: unknown[]
    ): Promise<number> => {
      const query = strings.join('?')
      assert.ok(
        query.includes('DELETE FROM "rate_limit_buckets"'),
        `unexpected $executeRaw query: ${query}`,
      )
      // Mirror the real DELETE: optional bucket scoping, then window expiry.
      const bucketFilter = query.includes('"bucket" = ?')
        ? String(values[0])
        : null
      const thresholdMs = (values[values.length - 1] as Date).getTime()
      let deleted = 0
      for (const [key, row] of this.rows) {
        if (bucketFilter !== null && row.bucket !== bucketFilter) continue
        if (row.windowStartMs < thresholdMs) {
          this.rows.delete(key)
          deleted += 1
        }
      }
      return deleted
    },
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

test('cleanup is scoped to its own bucket: short-window sweeps keep longer-window rows', async (t) => {
  // Start 14 minutes into a 15-minute window so the long bucket's live row
  // has a window_start older than the short bucket's 60s sweep threshold.
  t.mock.timers.enable({ apis: ['Date'], now: 900_000 + 840_000 })
  const store = new FakeRateLimitStore()
  const { RateLimiter } = await import('../src/services/rate-limit.js')
  // cleanupProbability 1.0: every hit sweeps, so the regression is deterministic.
  const limiter = new RateLimiter(store.prisma as never, noopLogger, 1.0)

  const SHORT: RateLimitRule = { max: 10, windowMs: 60_000 }
  const LONG: RateLimitRule = { max: 10, windowMs: 15 * 60_000 }
  const identity = 'ip:203.0.113.9'

  // One live hit on the long (15-min) bucket.
  assert.equal((await limiter.check('test.long', LONG, identity)).count, 1)

  // Thirty seconds later the long window is still live, but the short bucket's
  // sweep threshold (now - 60s) is past the long row's window_start. The
  // unscoped DELETE used to wipe the long row here, resetting its counter.
  t.mock.timers.tick(30_000)
  await limiter.check('test.short', SHORT, identity)

  // The long bucket's live row survives and its count continues on the same row.
  const continued = await limiter.check('test.long', LONG, identity)
  assert.equal(continued.count, 2)
  assert.equal(continued.limited, false)
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

test('lockout audit event fires once per bucket per window — on the transition only', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_700_000_000_000 })
  const store = new FakeRateLimitStore()
  const limiter = await createLimiter(store)
  auditWrites.length = 0
  const rules = { ip: { bucket: 'test.audit.ip', rule: { max: 2, windowMs: 60_000 } } }

  // max = 2: hits 1-2 allowed, hit 3 trips (count === max + 1 → transition,
  // one audit write). Three MORE hits past the cap must emit nothing.
  const outcomes: boolean[] = []
  for (let i = 0; i < 6; i += 1) {
    outcomes.push(
      (await limiter.guard({ rules, ip: '203.0.113.50' })).allowed,
    )
  }
  assert.deepEqual(outcomes, [true, true, false, false, false, false])
  assert.equal(auditWrites.length, 1)

  // A new window starts a fresh counter; tripping it emits exactly one more.
  t.mock.timers.tick(60_000)
  for (let i = 0; i < 3; i += 1) {
    await limiter.guard({ rules, ip: '203.0.113.50' })
  }
  assert.equal(auditWrites.length, 2)
})

test('IPv6 identities share a /64 bucket; IPv4 stays per-address', async () => {
  const store = new FakeRateLimitStore()
  const limiter = await createLimiter(store)
  auditWrites.length = 0

  // Three distinct addresses inside one /64 share a single counter: the
  // third hit trips even though each address is unique.
  const v6Rules = { ip: { bucket: 'test.v6.ip', rule: { max: 2, windowMs: 60_000 } } }
  assert.equal((await limiter.guard({ rules: v6Rules, ip: '2001:db8:abcd:1::1' })).allowed, true)
  assert.equal((await limiter.guard({ rules: v6Rules, ip: '2001:db8:abcd:1::2' })).allowed, true)
  assert.equal(
    (await limiter.guard({ rules: v6Rules, ip: '2001:db8:abcd:1:ffff:eeee:dddd:cccc' })).allowed,
    false,
  )

  // A different /64 gets its own bucket.
  assert.equal((await limiter.guard({ rules: v6Rules, ip: '2001:db8:abcd:2::1' })).allowed, true)

  // IPv4 is unchanged: neighbouring addresses in the same /24 do NOT share
  // a bucket — only the exact repeating address trips.
  const v4Rules = { ip: { bucket: 'test.v4.ip', rule: { max: 1, windowMs: 60_000 } } }
  assert.equal((await limiter.guard({ rules: v4Rules, ip: '203.0.113.1' })).allowed, true)
  assert.equal((await limiter.guard({ rules: v4Rules, ip: '203.0.113.2' })).allowed, true)
  assert.equal((await limiter.guard({ rules: v4Rules, ip: '203.0.113.1' })).allowed, false)
})
