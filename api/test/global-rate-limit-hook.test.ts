import assert from 'node:assert/strict'
import { register } from 'node:module'
import test from 'node:test'

/**
 * The API-wide rate-limit hook (2026-09-05 review, FO3-3 / FO3-6 / FO3-7).
 *
 * Three things are pinned here, each of which was false before:
 *  - every route declaring `config.public` is limited, without the route
 *    naming a bucket, so coverage is a property of being public rather than of
 *    somebody remembering;
 *  - a route the table names is limited on that bucket, not the public floor;
 *  - the check runs at `onRequest`, so a rejected request is never body-parsed.
 *
 * The store is faked, the limiter under test is the real `RateLimiter`, and
 * the hook under test is the real `registerGlobalAuthHook`.
 */

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
  '  throw new Error("@nessie/db is stubbed in global-rate-limit-hook.test.ts")',
  '}',
  'export const writeAuditEntry = async () => {}',
  'export const enqueueQueueJob = async () => {}',
  'export const buildVisibleAgentWhere = () => {',
  '  throw new Error("agent visibility is not used here")',
  '}',
  'export const buildAgentVisibilityWhere = () => {',
  '  throw new Error("agent visibility is not used here")',
  '}',
  'export const visibleKnowledgeSpaceWhere = () => {',
  '  throw new Error("knowledge-space visibility is not used here")',
  '}',
  'export const listVisibleAgentIdsForUser = async () => {',
  '  throw new Error("agent visibility is not used here")',
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

class FakeRateLimitStore {
  readonly rows = new Map<string, number>()
  readonly buckets: string[] = []

  readonly prisma = {
    $queryRaw: async (
      strings: TemplateStringsArray,
      ...values: unknown[]
    ): Promise<Array<{ count: number }>> => {
      assert.ok(strings.join('?').includes('INSERT INTO "rate_limit_buckets"'))
      const bucket = String(values[1])
      this.buckets.push(bucket)
      const key = `${bucket}|${String(values[2])}|${(values[3] as Date).toISOString()}`
      const count = (this.rows.get(key) ?? 0) + 1
      this.rows.set(key, count)
      return [{ count }]
    },
    $executeRaw: async (): Promise<number> => 0,
  }
}

const { default: Fastify } = await import('fastify')
const { RateLimiter } = await import('../src/services/rate-limit.js')
const { registerGlobalAuthHook } = await import('../src/lib/global-auth-hook.js')

const noopLogger = { error: () => {} }

const buildApp = async (input: {
  store: FakeRateLimitStore
  publicRouteMax?: number
  threadMessageMax?: number
}) => {
  const app = Fastify({ logger: false })
  const parsedBodies: string[] = []
  // Replace Fastify's built-in JSON parser so this fixture can observe when
  // the body is parsed at all; an exact-match built-in otherwise wins over a
  // regexp parser.
  app.removeContentTypeParser('application/json')
  app.addContentTypeParser(
    /^application\/([a-z0-9.+-]+\+)?json($|;)/i,
    { parseAs: 'buffer' },
    (_request, body, done) => {
      parsedBodies.push(body.toString('utf8'))
      done(null, JSON.parse(body.toString('utf8')))
    },
  )

  const config = {
    api: {
      rateLimit: {
        publicRouteIp: { max: input.publicRouteMax ?? 2, windowMs: 60_000 },
        threadMessageIp: { max: input.threadMessageMax ?? 1, windowMs: 60_000 },
        authMeIp: { max: 50, windowMs: 60_000 },
      },
    },
  }
  const rateLimiter = new RateLimiter(input.store.prisma as never, noopLogger)
  registerGlobalAuthHook(app, {
    authenticateRequest: (async () => null) as never,
    config: config as never,
    prisma: {} as never,
    rateLimiter,
  })

  // A public route the table says nothing about: it gets the floor.
  app.post('/api/comms/webhooks/unknown-provider', { config: { public: true } }, async () => ({ ok: true }))
  // A public route the table names: it gets that bucket instead.
  app.post('/api/threads/:threadId/messages', { config: { public: true } }, async () => ({ ok: true }))
  // Neither public nor named: no limiter is consulted at all.
  app.get('/api/health', { config: { public: true } }, async () => ({ ok: true }))

  await app.ready()
  return { app, parsedBodies, rateLimiter }
}

const post = (
  app: Awaited<ReturnType<typeof buildApp>>['app'],
  url: string,
) => app.inject({
  method: 'POST',
  url,
  headers: { 'content-type': 'application/json' },
  payload: JSON.stringify({ hello: 'world' }),
})

test('a public route nobody named a bucket for is still limited, on the floor bucket', async () => {
  const store = new FakeRateLimitStore()
  const { app } = await buildApp({ store })

  assert.equal((await post(app, '/api/comms/webhooks/unknown-provider')).statusCode, 200)
  assert.equal((await post(app, '/api/comms/webhooks/unknown-provider')).statusCode, 200)
  const limited = await post(app, '/api/comms/webhooks/unknown-provider')
  assert.equal(limited.statusCode, 429)
  assert.equal(limited.json().error.code, 'RATE_LIMITED')
  assert.ok(Number(limited.headers['retry-after']) >= 1)
  assert.deepEqual([...new Set(store.buckets)], ['api.public.ip'])

  await app.close()
})

test('a route the table names counts against its own bucket, not the floor', async () => {
  const store = new FakeRateLimitStore()
  const { app } = await buildApp({ store })

  assert.equal((await post(app, '/api/threads/t1/messages')).statusCode, 200)
  assert.equal((await post(app, '/api/threads/t1/messages')).statusCode, 429)
  assert.deepEqual([...new Set(store.buckets)], ['api.thread_message.ip'])

  await app.close()
})

test('a rejected request is never body-parsed: the limiter runs at onRequest', async () => {
  const store = new FakeRateLimitStore()
  const { app, parsedBodies } = await buildApp({ store, threadMessageMax: 1 })

  await post(app, '/api/threads/t1/messages')
  assert.equal(parsedBodies.length, 1)
  const limited = await post(app, '/api/threads/t1/messages')
  assert.equal(limited.statusCode, 429)
  // Still one: the 429 was decided before the JSON parser ever saw the bytes.
  assert.equal(parsedBodies.length, 1)

  await app.close()
})

test('a route with no bucket and no public flag consults no limiter', async () => {
  const store = new FakeRateLimitStore()
  const app = Fastify({ logger: false })
  const rateLimiter = new RateLimiter(store.prisma as never, noopLogger)
  registerGlobalAuthHook(app, {
    authenticateRequest: (async () => null) as never,
    config: { api: { rateLimit: {} } } as never,
    prisma: {} as never,
    rateLimiter,
  })
  app.get('/api/dashboards', async () => ({ ok: true }))
  await app.ready()

  for (let index = 0; index < 5; index += 1) {
    await app.inject({ method: 'GET', url: '/api/dashboards' })
  }
  assert.equal(rateLimiter.snapshot().checks, 0)

  await app.close()
})
