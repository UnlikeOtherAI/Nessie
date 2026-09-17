import assert from 'node:assert/strict'
import { register } from 'node:module'
import test from 'node:test'

/**
 * Origin posture for `POST /api/auth/session` — the same rule the refresh
 * route already enforces. The route SETS the SameSite=None refresh cookie
 * (admin and API are sibling subdomains — deliberate), so a cross-site
 * browser request reaches it with cookies attached: a present Origin must
 * name an origin this deployment serves. An ABSENT Origin must still pass —
 * the CLI, the desktop app and curl send none, and refusing them is the
 * regression that would break every non-browser client.
 *
 * Store and DB access are faked; the absent/allowed-Origin cases assert the
 * request reaches the ordinary credential pipeline (a 401 for an unknown
 * user, with the user lookup observed), which is what "not refused by the
 * Origin guard" means for a non-browser client.
 */

// --- @nessie/db stub: the route module graph imports it transitively --------
// Same passthrough-by-file-URL pattern as auth-rate-limit-routes.test.ts —
// a data: URL module cannot resolve a bare specifier, and resolving
// '@nessie/db' from inside the stub would re-enter this loader.
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
  '  summarizeRateLimitWindows,',
  '  takeRateLimitSlot,',
  `} from ${JSON.stringify(dbRateLimitUrl)}`,
  'export const disconnectPrismaClient = async () => {}',
  'export const getPrismaClient = () => {',
  '  throw new Error("@nessie/db is stubbed in auth-login-origin.test.ts")',
  '}',
  'export const writeAuditEntry = async () => {}',
  'export const enqueueQueueJob = async () => {}',
  'export const buildVisibleAgentWhere = () => {',
  '  throw new Error("agent visibility is not used by auth-login-origin.test.ts")',
  '}',
  'export const buildAgentVisibilityWhere = () => {',
  '  throw new Error("agent visibility is not used by auth-login-origin.test.ts")',
  '}',
  'export const visibleKnowledgeSpaceWhere = () => {',
  '  throw new Error("knowledge-space visibility is not used by auth-login-origin.test.ts")',
  '}',
  'export const listVisibleAgentIdsForUser = async () => {',
  '  throw new Error("agent visibility is not used by auth-login-origin.test.ts")',
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

const { default: Fastify } = await import('fastify')
const { registerAuthLoginRoute } = await import('../src/routes/auth-login.js')

const ALLOWED_ORIGIN = 'https://app.nessie.works'

/** Records whether the handler reached the credential lookup at all. */
const buildApp = async (prismaSpy: { userFindUniqueCalls: number }) => {
  const app = Fastify({ logger: false })
  registerAuthLoginRoute(
    app,
    {
      allowedCorsOrigins: new Set([ALLOWED_ORIGIN]),
      authSecret: 'origin-test-secret',
      config: {
        // The password branch is gated to local installs; it is the lane the
        // CLI uses, which is exactly the client this guard must not break.
        mode: 'local',
        api: {
          rateLimit: {
            loginIp: { max: 1_000, windowMs: 60_000 },
            loginAccount: { max: 1_000, windowMs: 60_000 },
          },
        },
        auth: { providers: [] },
      },
      prisma: {
        user: {
          findUnique: async () => {
            prismaSpy.userFindUniqueCalls += 1
            return null
          },
        },
      },
      rateLimiter: { guard: async () => ({ allowed: true }) },
      teamHostBaseDomain: undefined,
      buildLocalSession: () => {
        throw new Error('not reached for an unknown user')
      },
      buildSessionForUser: () => {
        throw new Error('not reached for an unknown user')
      },
    } as never,
    (async () => {}) as never,
  )
  await app.ready()
  return app
}

const login = (
  app: Awaited<ReturnType<typeof buildApp>>,
  origin?: string,
) =>
  app.inject({
    method: 'POST',
    url: '/api/auth/session',
    headers: {
      'content-type': 'application/json',
      ...(origin ? { origin } : {}),
    },
    payload: JSON.stringify({ email: 'cli-user@example.com', password: 'pw' }),
  })

test('a present, unallowed Origin is refused before any credential work', async () => {
  const spy = { userFindUniqueCalls: 0 }
  const app = await buildApp(spy)

  const response = await login(app, 'https://evil.example')

  assert.equal(response.statusCode, 403)
  assert.equal(response.json().error.code, 'ORIGIN_FORBIDDEN')
  assert.equal(spy.userFindUniqueCalls, 0, 'the guard runs before the credential lookup')
  await app.close()
})

test('an absent Origin still reaches the login pipeline (CLI, desktop, curl)', async () => {
  const spy = { userFindUniqueCalls: 0 }
  const app = await buildApp(spy)

  const response = await login(app)

  // Unknown user, so the ordinary answer is 401 INVALID_CREDENTIALS — the
  // point is that the request got there: no 403, and the lookup ran.
  assert.equal(response.statusCode, 401)
  assert.equal(response.json().error.code, 'INVALID_CREDENTIALS')
  assert.equal(spy.userFindUniqueCalls, 1)
  await app.close()
})

test('a present, allowed Origin reaches the login pipeline', async () => {
  const spy = { userFindUniqueCalls: 0 }
  const app = await buildApp(spy)

  const response = await login(app, ALLOWED_ORIGIN)

  assert.equal(response.statusCode, 401)
  assert.equal(response.json().error.code, 'INVALID_CREDENTIALS')
  assert.equal(spy.userFindUniqueCalls, 1)
  await app.close()
})
