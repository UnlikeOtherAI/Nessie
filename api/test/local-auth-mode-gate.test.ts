import assert from 'node:assert/strict'
import { register } from 'node:module'
import test from 'node:test'

/**
 * The local-password stack is a `local`-mode capability only (UOA SSO gap
 * analysis, phase 1). The admin login screen already hid it outside local
 * mode; these tests pin the *server* refusals, which is what an SSO
 * deployment actually depends on:
 *
 *   - the password branch of `POST /api/auth/session` → 403 PASSWORD_AUTH_DISABLED
 *   - `POST /api/users` (creates a human WITH a password) → 403 LOCAL_USER_CREATION_DISABLED
 *   - `POST /api/auth/password` → 403 PASSWORD_AUTH_DISABLED
 *
 * Each gate is also asserted *open* in local mode (the request reaches the
 * next step of the real handler), and the SSO branch of the login route is
 * asserted untouched in a non-local mode — the gate is scoped to the password
 * branch, not to the route.
 */

// --- @nessie/db stub: the route module graph imports it transitively --------
const dbStub = [
  'export const disconnectPrismaClient = async () => {}',
  'export const getPrismaClient = () => {',
  '  throw new Error("@nessie/db is stubbed in local-auth-mode-gate.test.ts")',
  '}',
  'export const writeAuditEntry = async () => {}',
  'export const enqueueQueueJob = async () => {}',
  'export const buildVisibleAgentWhere = () => {',
  '  throw new Error("agent visibility is not used by local-auth-mode-gate.test.ts")',
  '}',
  'export const visibleKnowledgeSpaceWhere = () => {',
  '  throw new Error("knowledge-space visibility is not used by local-auth-mode-gate.test.ts")',
  '}',
  'export const listVisibleAgentIdsForUser = async () => {',
  '  throw new Error("agent visibility is not used by local-auth-mode-gate.test.ts")',
  '}',
  'export const writeAuditEntryInTransaction = async () => {}',
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
const { RateLimiter } = await import('../src/services/rate-limit.js')
const { registerAuthLoginRoute } = await import('../src/routes/auth-login.js')
const { registerAuthSecurityRoutes } = await import('../src/routes/auth-security.js')
const { registerUserRoutes } = await import('../src/routes/users.js')

type Mode = 'local' | 'selfHosted' | 'hosted'

const NON_LOCAL_MODES: Mode[] = ['hosted', 'selfHosted']

const rateLimitRule = { max: 1000, windowMs: 10 * 60_000 }

const makeConfig = (mode: Mode) => ({
  mode,
  api: {
    rateLimit: {
      loginIp: rateLimitRule,
      loginAccount: rateLimitRule,
      stepUpIp: rateLimitRule,
      stepUpAccount: rateLimitRule,
    },
  },
})

// A permissive limiter: every gate test must fail on the mode check, never on
// a 429. The store is faked so no database is involved.
const makeRateLimiter = () =>
  new RateLimiter(
    {
      $queryRaw: async () => [{ count: 1 }],
      $executeRaw: async () => 0,
    } as never,
    { error: () => {} } as never,
  )

const actorContext = {
  actor: { actorType: 'user', actorId: 'user-1', roles: ['owner'] },
  tenant: { organizationId: 'org-1', projectId: 'project-1', teamId: 'team-1' },
  actionContext: { requestId: 'req-mode-gate' },
}

/** Records whether the handler reached the database at all. */
class PrismaSpy {
  userFindUniqueCalls = 0

  readonly client = {
    user: {
      findUnique: async () => {
        this.userFindUniqueCalls += 1
        return null
      },
    },
  }
}

const buildLoginApp = async (mode: Mode, prismaSpy: PrismaSpy) => {
  const app = Fastify({ logger: false })
  registerAuthLoginRoute(
    app,
    {
      authSecret: 'test-secret',
      config: makeConfig(mode),
      prisma: prismaSpy.client,
      rateLimiter: makeRateLimiter(),
      buildLocalSession: () => {
        throw new Error('not reached in mode-gate tests')
      },
      buildSessionForUser: () => {
        throw new Error('not reached in mode-gate tests')
      },
    } as never,
    (async () => {}) as never,
  )
  await app.ready()
  return app
}

const buildUsersApp = async (mode: Mode) => {
  const app = Fastify({ logger: false })
  registerUserRoutes(app, {
    MEMBERSHIP_ROLES: ['owner', 'admin', 'member', 'viewer'],
    config: makeConfig(mode),
    prisma: {} as never,
    requireActorContext: () => actorContext,
    requireOwner: () => true,
    // Only an unknown role is submitted below, so this never has to resolve.
    resolveMembershipRole: () => null,
  } as never)
  await app.ready()
  return app
}

const buildSecurityApp = async (mode: Mode, prismaSpy: PrismaSpy) => {
  const app = Fastify({ logger: false })
  registerAuthSecurityRoutes(
    app,
    {
      authSecret: 'test-secret',
      buildSessionForUser: () => {
        throw new Error('not reached in mode-gate tests')
      },
      config: makeConfig(mode),
      getAuthorizationToken: () => null,
      prisma: prismaSpy.client,
      rateLimiter: makeRateLimiter(),
      requireActorContext: () => actorContext,
    } as never,
    (async () => {}) as never,
  )
  await app.ready()
  return app
}

const postJson = (
  app: Awaited<ReturnType<typeof buildLoginApp>>,
  url: string,
  payload: unknown,
) =>
  app.inject({
    method: 'POST',
    url,
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify(payload),
  })

// --- POST /api/auth/session (password branch) --------------------------------

for (const mode of NON_LOCAL_MODES) {
  test(`password login is refused in ${mode} mode without touching the database`, async () => {
    const prismaSpy = new PrismaSpy()
    const app = await buildLoginApp(mode, prismaSpy)

    const response = await postJson(app, '/api/auth/session', {
      email: 'owner@example.com',
      password: 'correct-horse-battery',
    })

    assert.equal(response.statusCode, 403)
    assert.equal(response.json().error.code, 'PASSWORD_AUTH_DISABLED')
    assert.match(response.json().error.message, /identity provider/i)
    // The account is never looked up, so the refusal cannot be used as an
    // account-existence oracle.
    assert.equal(prismaSpy.userFindUniqueCalls, 0)

    await app.close()
  })

  test(`a credential-less password attempt is also refused in ${mode} mode`, async () => {
    const prismaSpy = new PrismaSpy()
    const app = await buildLoginApp(mode, prismaSpy)

    // In local mode this shape is a 400 PASSWORD_REQUIRED; the capability
    // refusal has to come first, or the route advertises a password prompt it
    // will never honour.
    const response = await postJson(app, '/api/auth/session', {})

    assert.equal(response.statusCode, 403)
    assert.equal(response.json().error.code, 'PASSWORD_AUTH_DISABLED')

    await app.close()
  })

  test(`the SSO branch is untouched in ${mode} mode`, async () => {
    const prismaSpy = new PrismaSpy()
    const app = await buildLoginApp(mode, prismaSpy)

    const response = await postJson(app, '/api/auth/session', { providerId: 'uoa' })

    // Reaches the SSO branch's own validation — not the password gate.
    assert.equal(response.statusCode, 400)
    assert.equal(response.json().error.code, 'EXTERNAL_AUTH_INCOMPLETE')

    await app.close()
  })
}

test('password login still runs in local mode', async () => {
  const prismaSpy = new PrismaSpy()
  const app = await buildLoginApp('local', prismaSpy)

  const response = await postJson(app, '/api/auth/session', {
    email: 'owner@example.com',
    password: 'correct-horse-battery',
  })

  // No such user in the fake, so the real handler answers 401 — which is only
  // reachable past the gate, and only after the account lookup ran.
  assert.equal(response.statusCode, 401)
  assert.equal(response.json().error.code, 'INVALID_CREDENTIALS')
  assert.equal(prismaSpy.userFindUniqueCalls, 1)

  await app.close()
})

test('local mode still answers a credential-less attempt with PASSWORD_REQUIRED', async () => {
  const prismaSpy = new PrismaSpy()
  const app = await buildLoginApp('local', prismaSpy)

  const response = await postJson(app, '/api/auth/session', {})

  assert.equal(response.statusCode, 400)
  assert.equal(response.json().error.code, 'PASSWORD_REQUIRED')

  await app.close()
})

// --- POST /api/users ---------------------------------------------------------

for (const mode of NON_LOCAL_MODES) {
  test(`local account creation is refused in ${mode} mode`, async () => {
    const app = await buildUsersApp(mode)

    const response = await postJson(app, '/api/users', {
      email: 'new.hire@example.com',
      displayName: 'New Hire',
      password: 'correct-horse-battery',
      role: 'member',
    })

    assert.equal(response.statusCode, 403)
    assert.equal(response.json().error.code, 'LOCAL_USER_CREATION_DISABLED')
    assert.match(response.json().error.message, /SSO or an invitation/i)

    await app.close()
  })
}

test('local account creation still runs in local mode', async () => {
  const app = await buildUsersApp('local')

  const response = await postJson(app, '/api/users', {
    email: 'new.hire@example.com',
    displayName: 'New Hire',
    password: 'correct-horse-battery',
    role: 'not-a-role',
  })

  // Past the gate and into the handler's own role validation (the fake
  // resolver rejects every role), which is only reachable in local mode.
  assert.equal(response.statusCode, 400)
  assert.equal(response.json().error.code, 'INVALID_ROLE')

  await app.close()
})

// --- POST /api/auth/password -------------------------------------------------

for (const mode of NON_LOCAL_MODES) {
  test(`password change is refused in ${mode} mode without touching the database`, async () => {
    const prismaSpy = new PrismaSpy()
    const app = await buildSecurityApp(mode, prismaSpy)

    const response = await postJson(app, '/api/auth/password', {
      currentPassword: 'old-password',
      newPassword: 'correct-horse-battery',
    })

    assert.equal(response.statusCode, 403)
    assert.equal(response.json().error.code, 'PASSWORD_AUTH_DISABLED')
    assert.equal(prismaSpy.userFindUniqueCalls, 0)

    await app.close()
  })
}

test('password change still runs in local mode', async () => {
  const prismaSpy = new PrismaSpy()
  const app = await buildSecurityApp('local', prismaSpy)

  const response = await postJson(app, '/api/auth/password', {
    currentPassword: 'old-password',
    newPassword: 'correct-horse-battery',
  })

  // The fake user has no password hash, so the real handler answers
  // PASSWORD_NOT_SUPPORTED — reachable only past the gate, and only after the
  // account was actually read.
  assert.equal(response.statusCode, 400)
  assert.equal(response.json().error.code, 'PASSWORD_NOT_SUPPORTED')
  assert.equal(prismaSpy.userFindUniqueCalls, 1)

  await app.close()
})
