import assert from 'node:assert/strict'
import { register } from 'node:module'
import test from 'node:test'

/**
 * Route-level coverage for the auth brute-force limiter (issue #211):
 * 429 + Retry-After when a limit trips, per-account vs per-IP independence,
 * NESSIE_API_TRUSTED_PROXY_HOPS honoured vs ignored, fail-open on store
 * error, and /api/health unlimited. Store and DB access are faked; the limiter
 * under test is the real `RateLimiter` wired into the real route registrar.
 */

// --- @nessie/db stub: the route module graph imports it transitively --------
// The counter statement itself is NOT stubbed: `rate-limit-window.ts` in
// @nessie/db owns the `rate_limit_buckets` SQL that both this limiter and the
// worker's outbound UOA pacer issue, and the fake `$queryRaw`/`$executeRaw`
// below are what assert on it. The stub re-exports the real module by file URL
// (a data: URL module cannot resolve a bare specifier, and resolving
// '@nessie/db' from inside the stub would re-enter this loader).
const dbRateLimitUrl = new URL(
  '../../packages/db/src/rate-limit-window.ts',
  import.meta.url,
).href
const dbStub = [
  'export {',
  '  clearRateLimitWindows,',
  '  countRateLimitHit,',
  '  pruneRateLimitWindows,',
  '  rateLimitKeyHash,',
  '  rateLimitWindowStart,',
  '  takeRateLimitSlot,',
  `} from ${JSON.stringify(dbRateLimitUrl)}`,
  'export const disconnectPrismaClient = async () => {}',
  'export const getPrismaClient = () => {',
  '  throw new Error("@nessie/db is stubbed in auth-rate-limit-routes.test.ts")',
  '}',
  'export const writeAuditEntry = async () => {}',
  'export const enqueueQueueJob = async () => {}',
  'export const buildVisibleAgentWhere = () => {',
  '  throw new Error("agent visibility is not used by auth-rate-limit-routes.test.ts")',
  '}',
  'export const buildAgentVisibilityWhere = () => {',
  '  throw new Error("agent visibility is not used by auth-rate-limit-routes.test.ts")',
  '}',
  'export const visibleKnowledgeSpaceWhere = () => {',
  '  throw new Error("knowledge-space visibility is not used by auth-rate-limit-routes.test.ts")',
  '}',
  'export const listVisibleAgentIdsForUser = async () => {',
  '  throw new Error("agent visibility is not used by auth-rate-limit-routes.test.ts")',
  '}',
  'export const writeAuditEntryInTransaction = async () => {}',
  'export const withSweepLock = async (_db, _name, fn) => ({ ran: true, result: await fn() })',
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

// --- Fake rate-limit store ---------------------------------------------------
class FakeRateLimitStore {
  readonly rows = new Map<string, number>()
  failAll = false

  readonly prisma = {
    $queryRaw: async (
      strings: TemplateStringsArray,
      ...values: unknown[]
    ): Promise<Array<{ count: number; window_start_ms: number; now_ms: number }>> => {
      if (this.failAll) {
        throw new Error('simulated store outage')
      }
      const query = strings.join('?')
      assert.ok(query.includes('INSERT INTO "rate_limit_buckets"'))
      // Positional args: clock override (null → the store's own clock, because
      // the statement floors the window from the DATABASE's NOW()), windowMs,
      // id, bucket, keyHash.
      const nowMs = (values[0] as number | null) ?? Date.now()
      const windowStartMs = Math.floor(nowMs / Number(values[1])) * Number(values[1])
      const key = `${String(values[3])}|${String(values[4])}|${windowStartMs}`
      const count = (this.rows.get(key) ?? 0) + 1
      this.rows.set(key, count)
      return [{ count, now_ms: nowMs, window_start_ms: windowStartMs }]
    },
    $executeRaw: async (): Promise<number> => 0,
  }
}

const { default: Fastify } = await import('fastify')
const { RateLimiter } = await import('../src/services/rate-limit.js')
const { registerAuthLoginRoute } = await import('../src/routes/auth-login.js')
const { registerHealthRoutes } = await import('../src/routes/health.js')
const { createLifecycleState } = await import('../src/lifecycle.js')
const { createFastifyTrustProxyConfig } = await import('../src/lib/server-context.js')

const noopLogger = { error: () => {} }

const buildLoginApp = async (input: {
  store: FakeRateLimitStore
  trustedProxyHops: number
  loginIpMax?: number
  loginAccountMax?: number
}) => {
  const app = Fastify({
    logger: false,
    trustProxy: createFastifyTrustProxyConfig(input.trustedProxyHops),
  })
  const rateLimiter = new RateLimiter(input.store.prisma as never, noopLogger)
  const config = {
    // The password branch is gated to `local` mode; these tests exercise the
    // limiter on that branch, so the fixture must be a local install.
    mode: 'local' as const,
    api: {
      rateLimit: {
        loginIp: { max: input.loginIpMax ?? 2, windowMs: 10 * 60_000 },
        loginAccount: { max: input.loginAccountMax ?? 1, windowMs: 10 * 60_000 },
      },
    },
  }
  const deps = {
    authSecret: 'test-secret',
    config,
    // The login handler only touches prisma after the guard, and then only
    // to load the user; returning null yields a clean 401.
    prisma: { user: { findUnique: async () => null } } as never,
    rateLimiter,
    buildLocalSession: (() => {
      throw new Error('not reached in rate-limit tests')
    }) as never,
    buildSessionForUser: (() => {
      throw new Error('not reached in rate-limit tests')
    }) as never,
  }
  registerAuthLoginRoute(app, deps as never, (async () => {}) as never)
  await app.ready()
  return app
}

const login = (
  app: Awaited<ReturnType<typeof buildLoginApp>>,
  headers: Record<string, string>,
  email = 'attacker@example.com',
) =>
  app.inject({
    method: 'POST',
    url: '/api/auth/session',
    headers: { 'content-type': 'application/json', ...headers },
    payload: JSON.stringify({ email, password: 'wrong-password' }),
  })

test('login limit trips: 429 + Retry-After once the per-IP counter exceeds max', async () => {
  const store = new FakeRateLimitStore()
  const app = await buildLoginApp({ store, trustedProxyHops: 0 })

  // loginAccount max is 1, so the second attempt for the same email is
  // already limited by the account counter; use a fresh email per attempt to
  // isolate the per-IP counter (max 2).
  const first = await login(app, {}, 'a@example.com')
  const second = await login(app, {}, 'b@example.com')
  const third = await login(app, {}, 'c@example.com')

  assert.equal(first.statusCode, 401)
  assert.equal(second.statusCode, 401)
  assert.equal(third.statusCode, 429)
  assert.equal(third.json().error.code, 'RATE_LIMITED')
  const retryAfter = Number(third.headers['retry-after'])
  assert.ok(Number.isFinite(retryAfter) && retryAfter >= 1)

  await app.close()
})

test('login account identity is normalized: email variants share one counter', async () => {
  const store = new FakeRateLimitStore()
  // Account max 1, IP max high: only the account bucket can trip, so a 429
  // proves the variant hit the SAME account counter as the first attempt
  // (unnormalized keys would give each variant a fresh bucket and a bypass).
  const app = await buildLoginApp({
    store,
    trustedProxyHops: 0,
    loginIpMax: 10,
    loginAccountMax: 1,
  })

  assert.equal((await login(app, {}, 'a@x.com')).statusCode, 401)
  assert.equal((await login(app, {}, 'A@x.com')).statusCode, 429)
  // Whitespace-padded variants are rejected by schema validation (400)
  // before the guard runs, so they can never reach the account lookup —
  // the normalization fix is what covers any variant that does validate.
  assert.equal((await login(app, {}, ' a@x.com ')).statusCode, 400)

  await app.close()
})

test('per-account and per-IP counters are independent', async () => {
  const store = new FakeRateLimitStore()
  const app = await buildLoginApp({ store, trustedProxyHops: 0 })
  const loginFrom = (remoteAddress: string, email: string) =>
    app.inject({
      method: 'POST',
      url: '/api/auth/session',
      remoteAddress,
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ email, password: 'wrong-password' }),
    })

  // Account counter (max 1): the same email from a *different* remote IP is
  // rejected by the account bucket even though that IP's own counter is
  // empty — the two dimensions never share a counter.
  assert.equal((await loginFrom('203.0.113.10', 'same@example.com')).statusCode, 401)
  assert.equal((await loginFrom('198.51.100.99', 'same@example.com')).statusCode, 429)

  // IP counter (max 2): a fresh email from the first IP clears the account
  // bucket, but that IP already has one hit; one more request is allowed and
  // the next trips the IP bucket — independent of which account is used.
  assert.equal((await loginFrom('203.0.113.10', 'other@example.com')).statusCode, 401)
  assert.equal((await loginFrom('203.0.113.10', 'third@example.com')).statusCode, 429)

  await app.close()
})

test('X-Forwarded-For is honoured only up to NESSIE_API_TRUSTED_PROXY_HOPS', async () => {
  // Hops = 0: forwarded header ignored — every request shares the socket IP
  // bucket, so the third request trips the per-IP limit (max 2) despite
  // spoofed distinct forwarded addresses.
  const untrustedStore = new FakeRateLimitStore()
  const untrusted = await buildLoginApp({ store: untrustedStore, trustedProxyHops: 0 })
  assert.equal((await login(untrusted, { 'x-forwarded-for': '203.0.113.1' }, 'a@x.com')).statusCode, 401)
  assert.equal((await login(untrusted, { 'x-forwarded-for': '203.0.113.2' }, 'b@x.com')).statusCode, 401)
  assert.equal((await login(untrusted, { 'x-forwarded-for': '203.0.113.3' }, 'c@x.com')).statusCode, 429)
  await untrusted.close()

  // Hops = 1: each distinct forwarded client gets its own bucket, so three
  // spoofed addresses each stay under the per-IP limit. (The account limit
  // is 1, so use a fresh email per request.)
  const trustedStore = new FakeRateLimitStore()
  const trusted = await buildLoginApp({ store: trustedStore, trustedProxyHops: 1 })
  assert.equal((await login(trusted, { 'x-forwarded-for': '203.0.113.1' }, 'a@x.com')).statusCode, 401)
  assert.equal((await login(trusted, { 'x-forwarded-for': '203.0.113.2' }, 'b@x.com')).statusCode, 401)
  assert.equal((await login(trusted, { 'x-forwarded-for': '203.0.113.3' }, 'c@x.com')).statusCode, 401)
  // But one address repeating now trips: its own bucket is at max.
  assert.equal((await login(trusted, { 'x-forwarded-for': '203.0.113.1' }, 'd@x.com')).statusCode, 401)
  assert.equal((await login(trusted, { 'x-forwarded-for': '203.0.113.1' }, 'e@x.com')).statusCode, 429)
  await trusted.close()
})

test('the guard fails open when the store errors', async () => {
  const store = new FakeRateLimitStore()
  store.failAll = true
  const app = await buildLoginApp({ store, trustedProxyHops: 0 })

  for (let i = 0; i < 5; i += 1) {
    const response = await login(app, {})
    assert.equal(response.statusCode, 401)
  }
  await app.close()
})

test('/api/health carries no rate limit', async () => {
  const store = new FakeRateLimitStore()
  const app = Fastify({ logger: false })
  const rateLimiter = new RateLimiter(store.prisma as never, noopLogger)
  registerHealthRoutes(app, {
    lifecycle: createLifecycleState(),
    prisma: {} as never,
    rateLimiter,
    requireActorContext: (() => null) as never,
    requireOwner: (() => false) as never,
  } as never)
  await app.ready()

  for (let i = 0; i < 10; i += 1) {
    const response = await app.inject({ method: 'GET', url: '/api/health' })
    assert.equal(response.statusCode, 200)
  }
  // The limiter was never consulted.
  assert.equal(rateLimiter.snapshot().checks, 0)
  await app.close()
})
