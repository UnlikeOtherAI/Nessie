import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync, randomUUID } from 'node:crypto'
import { register } from 'node:module'
import { afterEach, beforeEach } from 'node:test'

import {
  makePrisma,
  type FakeInput,
} from './auth-login-workspace-target-prisma.js'

/**
 * Shared fixture for the workspace-switch recovery login route tests: module
 * stubs (@nessie/db, @nessie/runtime egress), the scripted UOA upstream
 * (token exchange + billing confirm), the real session issuers, and the app
 * builder. The in-memory Prisma fake lives in
 * auth-login-workspace-target-prisma.ts; its `model.method` call log lets
 * tests prove the recovery path never resolves a principal by email.
 */

// --- @nessie/db stub: the route module graph imports it transitively --------
const dbStub = [
  'export const disconnectPrismaClient = async () => {}',
  'export const getPrismaClient = () => {',
  '  throw new Error("@nessie/db is stubbed in the workspace-target tests")',
  '}',
  'export const writeAuditEntry = async () => {}',
].join('\n')
const dbStubUrl = `data:text/javascript,${encodeURIComponent(dbStub)}`
// --- @nessie/runtime stub: UOA egress goes through safeFetch, which pins a
// real socket; tests answer the upstream from a globalThis.fetch stub instead.
// Passthrough facade over the built runtime: explicit exports override the
// export-star, so only the two egress helpers are swapped for the fetch stub.
const runtimeDistUrl = new URL('../../packages/runtime/dist/index.js', import.meta.url).href
const runtimeStub = [
  `export * from ${JSON.stringify(runtimeDistUrl)}`,
  'export const safeFetch = async (url, init) => globalThis.fetch(url, init)',
  'export const pinnedFetch = async (url, init) => globalThis.fetch(url, init)',
].join('\n')
const runtimeStubUrl = `data:text/javascript,${encodeURIComponent(runtimeStub)}`
const moduleLoader = `
export async function resolve(specifier, context, nextResolve) {
  if (specifier === '@nessie/db') {
    return { shortCircuit: true, url: ${JSON.stringify(dbStubUrl)} }
  }
  if (specifier === '@nessie/runtime') {
    return { shortCircuit: true, url: ${JSON.stringify(runtimeStubUrl)} }
  }
  return nextResolve(specifier, context)
}
`
register(`data:text/javascript,${encodeURIComponent(moduleLoader)}`, import.meta.url)

export type FakeUser = {
  email: string
  id: string
  tokenVersion: number
  displayName?: string
}

export type Spy = { calls: string[] }
export type MutationSpy = Spy & { cookieIssued: boolean }
export type UpstreamSpy = { billingConfirms: number }

// --- UOA upstream environment -------------------------------------------------
const UOA_BASE_URL = 'https://authentication.unlikeotherai.com'
const UOA_DOMAIN = 'nessie.example.com'
const UOA_CLIENT_SECRET = 'test-uoa-client-secret'
const CLIENT_HASH = createHash('sha256')
  .update(UOA_DOMAIN + UOA_CLIENT_SECRET)
  .digest('hex')
const TEST_JWK = (() => {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const jwk = privateKey.export({ format: 'jwk' }) as { kid?: string }
  jwk.kid = 'test-kid'
  return JSON.stringify(jwk)
})()

const SAVED_ENV = [
  'UOA_DOMAIN',
  'UOA_CONFIG_URL',
  'UOA_JWKS_URL',
  'UOA_REDIRECT_URL',
  'UOA_CONFIG_JWT_PRIVATE_KEY_B64',
  'UOA_CONFIG_JWT_KID',
  'UOA_CLIENT_SECRET',
  'UOA_BILLING_APP_KEY_NESSIE',
  'UOA_BILLING_ACTOR_PRIVATE_JWK_NESSIE',
] as const
const savedEnv = new Map<string, string | undefined>()
const realFetch = globalThis.fetch

beforeEach(() => {
  for (const key of SAVED_ENV) savedEnv.set(key, process.env[key])
  process.env.UOA_DOMAIN = UOA_DOMAIN
  process.env.UOA_CONFIG_URL = 'https://nessie.example.com/.well-known/uoa-config'
  process.env.UOA_JWKS_URL = 'https://nessie.example.com/.well-known/jwks.json'
  process.env.UOA_REDIRECT_URL = 'nessie://auth/callback'
  process.env.UOA_CONFIG_JWT_PRIVATE_KEY_B64 = Buffer.from('unused-in-tests').toString('base64')
  process.env.UOA_CONFIG_JWT_KID = 'test-kid'
  process.env.UOA_CLIENT_SECRET = UOA_CLIENT_SECRET
  process.env.UOA_BILLING_APP_KEY_NESSIE = `uoa_app_${'n'.repeat(32)}`
  process.env.UOA_BILLING_ACTOR_PRIVATE_JWK_NESSIE = TEST_JWK
})

afterEach(() => {
  globalThis.fetch = realFetch
  for (const key of SAVED_ENV) {
    const value = savedEnv.get(key)
    if (value === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = value
    }
  }
})

const unsignedJwt = (claims: Record<string, unknown>): string =>
  `header.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.signature`

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })

/** Script the two UOA calls the exchange makes: token exchange + billing confirm. */
export const stubUoaUpstream = (
  spy: UpstreamSpy,
  token: string,
): void => {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString()
    if (url.startsWith(`${UOA_BASE_URL}/auth/token`)) {
      return json({
        access_token: token,
        expires_in: 600,
        refresh_token: 'rt-1',
        refresh_token_expires_in: 3600,
        token_type: 'Bearer',
      })
    }
    if (url.startsWith(`${UOA_BASE_URL}/billing/v1/`)) {
      spy.billingConfirms += 1
      return new Response(null, { status: 204, headers: { 'cache-control': 'no-store' } })
    }
    throw new Error(`unexpected fetch: ${url}`)
  }) as typeof globalThis.fetch
}

// --- Shared identity + app plumbing --------------------------------------------
export const AUTH_SECRET = 'test-secret'
export const ORG = 'uoa-org-a'
export const TEAM = 'uoa-team-a'

export const ALICE: FakeUser = {
  email: 'alice@example.com',
  id: randomUUID(),
  tokenVersion: 1,
  displayName: 'Alice Example',
}

const { default: Fastify } = await import('fastify')
const { issueSessionToken } = await import('../src/auth/session.js')
const { registerAuthLoginRoute } = await import('../src/routes/auth-login.js')
const { createSessionIssuers } = await import('../src/services/session-issuers.js')

/** Mint the current Nessie bearer Alice holds while switching workspaces. */
export const aliceBearer = (overrides?: {
  providerId?: string
  providerType?: string
  subject?: string
  tv?: number
  uoaIdentity?: Record<string, unknown> | false
}): string => issueSessionToken(
  {
    org: randomUUID(),
    proj: randomUUID(),
    providerId: overrides?.providerId ?? 'uoa',
    providerType: (overrides?.providerType ?? 'uoa') as never,
    roles: ['owner'],
    sub: overrides?.subject ?? ALICE.id,
    team: randomUUID(),
    tv: overrides?.tv ?? ALICE.tokenVersion,
    ...(overrides?.uoaIdentity === false
      ? {}
      : {
          uoaIdentity: {
            organizationId: ORG,
            subject: 'uoa-subject-alice',
            teamId: TEAM,
            tokenVersion: 3,
          },
        }),
  },
  AUTH_SECRET,
  3600,
).token

/** UOA's exchange response for a subject returning to the expected workspace. */
export const stubAliceExchange = (overrides?: {
  activeOrgId?: string
  activeTeamId?: string
  email?: string
  subject?: string
  tv?: number
}): UpstreamSpy => {
  const upstream: UpstreamSpy = { billingConfirms: 0 }
  stubUoaUpstream(upstream, unsignedJwt({
    active: {
      orgId: overrides?.activeOrgId ?? ORG,
      teamId: overrides?.activeTeamId ?? TEAM,
    },
    client_id: CLIENT_HASH,
    domain: UOA_DOMAIN,
    email: overrides?.email ?? ALICE.email,
    name: ALICE.displayName,
    org: {
      org_id: overrides?.activeOrgId ?? ORG,
      teams: [overrides?.activeTeamId ?? TEAM],
    },
    sub: overrides?.subject ?? 'uoa-subject-alice',
    tv: overrides?.tv ?? 3,
  }))
  return upstream
}

// --- App builder + request helpers ----------------------------------------------
export type BuildAppOptions = {
  rateLimiter?: { guard: () => Promise<{ allowed: boolean }> }
} & FakeInput

export const buildApp = async (
  spy: MutationSpy,
  options: BuildAppOptions = {},
) => {
  const app = Fastify({ logger: false })
  const prisma = makePrisma(spy, {
    users: [ALICE],
    ...options,
    organizationId: options.organizationId ?? randomUUID(),
  })
  const config = {
    api: {
      rateLimit: {
        loginIp: { max: 1_000, windowMs: 60_000 },
        loginAccount: { max: 1_000, windowMs: 60_000 },
      },
    },
    auth: {
      autoRedirectToSso: false,
      providers: [
        {
          autoRedirect: false,
          enabled: true,
          label: 'UnlikeOtherAI',
          providerId: 'uoa',
          type: 'uoa',
        },
      ],
      refreshTokenTtlSeconds: 3600,
    },
    model: {},
  }
  const deps = {
    authSecret: AUTH_SECRET,
    config,
    prisma,
    fileService: null,
    ledgerIdentity: null,
    sharedModelClient: null,
    getAuthorizationToken: (request: { headers: Record<string, string | string[] | undefined> }) => {
      const header = request.headers.authorization
      if (typeof header !== 'string') return null
      const [scheme, token] = header.split(' ')
      return scheme === 'Bearer' && token ? token : null
    },
    rateLimiter: options.rateLimiter ?? { guard: async () => ({ allowed: true }) },
    // Real issuers over the fake: the cookie is never actually issued on a
    // refused exchange, and the issued session must carry Alice's id.
    ...createSessionIssuers({
      authSecret: AUTH_SECRET,
      defaultProviderType: 'local',
      prisma: prisma as never,
      tokenTtlSeconds: 3600,
    }),
  }
  registerAuthLoginRoute(app, deps as never, (async () => {
    spy.cookieIssued = true
  }) as never)
  await app.ready()
  return app
}

export const recoveryExchange = (
  app: Awaited<ReturnType<typeof buildApp>>,
  input: {
    bearer?: string
    code?: string
    codeVerifier?: string
    omitCodeVerifier?: boolean
    expectedWorkspace?: { organizationId: string; teamId: string }
    providerId?: string
    redirectUri?: string
  } = {},
) =>
  app.inject({
    method: 'POST',
    url: '/api/auth/session',
    headers: {
      'content-type': 'application/json',
      ...(input.bearer ? { authorization: `Bearer ${input.bearer}` } : {}),
    },
    payload: JSON.stringify({
      code: input.code ?? 'code-1',
      ...(input.omitCodeVerifier
        ? {}
        : { codeVerifier: input.codeVerifier ?? 'verifier-1' }),
      providerId: input.providerId ?? 'uoa',
      redirectUri: input.redirectUri ?? 'nessie://auth/callback',
      ...(input.expectedWorkspace
        ? { expectedWorkspace: input.expectedWorkspace }
        : {}),
    }),
  })

/** The refusal leaves no trace: no billing confirm, no local write, no cookie. */
export const assertUntouched = (
  response: Awaited<ReturnType<Awaited<ReturnType<typeof buildApp>>['inject']>>,
  spy: MutationSpy,
  upstream: UpstreamSpy,
): void => {
  assert.equal(response.statusCode, 401)
  assert.equal(response.headers['set-cookie'], undefined)
  assert.equal(spy.cookieIssued, false)
  assert.equal(upstream.billingConfirms, 0)
  // The only permitted database traffic is reading the bearer's own user row
  // (by id) for the live tokenVersion check.
  assert.deepEqual(spy.calls.filter((call) => call !== 'user.findUnique:id'), [])
}

/** Recovery never touches identity by email and never creates/updates a user. */
export const assertNoEmailIdentityTraffic = (spy: MutationSpy): void => {
  assert.equal(
    spy.calls.filter((call) =>
      call === 'user.findUnique:email'
      || call === 'user.create'
      || call === 'user.update').length,
    0,
  )
}
