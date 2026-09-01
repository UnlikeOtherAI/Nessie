import assert from 'node:assert/strict'
import test from 'node:test'

import Fastify from 'fastify'

import type { PrismaClient } from '@prisma/client'
import type { AuthorizedActionContext } from '@nessie/schemas'
import type { SecretStore } from '@nessie/mcp-manage'

import {
  PublicOriginConfigError,
  resolvePublicOrigin,
  toPublicOrigin,
} from '../src/lib/public-origin.js'
import { registerMcpOAuthRoutes } from '../src/routes/mcp/oauth.js'
import { RateLimiter } from '../src/services/rate-limit.js'

/**
 * Security boundary hardening (docs/plans/2026-08-13-security-boundary-hardening.md,
 * Phase 0 item 5 / Workstream 5 'origin'): the MCP OAuth start path mints the
 * provider callback URL from ONE origin source —
 *
 *   • the configured `api.publicUrl` when set (request headers ignored), or
 *   • Fastify's trust-proxy-scoped protocol/hostname in local mode only;
 *     spoofed X-Forwarded-Proto/Host and a hostile direct Host header on an
 *     untrusted socket never leak into the minted URL, and
 *   • a hosted/selfHosted deployment without `api.publicUrl` fails loudly
 *     instead of trusting request-derived values (dynamic client
 *     registration would otherwise persist a steered redirect URI).
 *
 * The route tests use a static OAuth catalog entry over `.example` (RFC 2606
 * reserved — DNS fails fast, but the SSRF guard resolves it nowhere and
 * `startOAuth` never opens a socket in static mode), so no test traffic
 * leaves the process.
 */

const ORG_A = '00000000-0000-4000-8000-00000000000a'
const USER_A = '00000000-0000-4000-8000-00000000000c'

// A public DNS answer for every SSRF-checked host, so the static-config
// start flow passes the egress guard without touching the network (the
// upstream provider is never called — only the authorization URL is built).
const publicResolver = async (): Promise<string[]> => ['93.184.216.34']

const actorContext = {
  actor: { actorType: 'user', actorId: USER_A },
  tenant: { organizationId: ORG_A },
  actionContext: { requestId: 'req-public-origin-test' },
} as unknown as AuthorizedActionContext

const oauthInstance = {
  id: 'instance-1',
  catalogEntryId: 'catalog-1',
  organizationId: ORG_A,
  scopeType: 'organization',
  scopeId: ORG_A,
  credentialRef: null,
  transportConfig: {},
  discoveredTools: [],
  lifecycleState: 'pending_setup',
  healthLastCheckedAt: null,
  healthFailureCount: 0,
  installedBy: USER_A,
  createdAt: new Date(),
  updatedAt: new Date(),
}

const oauthCatalogEntry = {
  id: 'catalog-1',
  organizationId: ORG_A,
  name: 'oauth-server',
  label: 'OAuth Server',
  description: '',
  protocol: 'http',
  authMethod: 'oauth2',
  authConfig: {
    method: 'oauth2',
    authorizationUrl: 'https://provider.example/auth',
    tokenUrl: 'https://provider.example/token',
    clientId: 'test-client-id',
    scopes: ['read:repo'],
  },
  defaultTransportConfig: { transport: 'http', url: 'https://provider.example/mcp' },
  iconUrl: null,
  vendor: null,
  sourceUrl: null,
  signature: null,
  status: 'published',
  createdBy: USER_A,
  createdAt: new Date(),
  updatedAt: new Date(),
}

type TestConfig = {
  mode: 'hosted' | 'selfHosted' | 'local'
  api: { publicUrl?: string }
}

const makeApp = (
  config: TestConfig,
  fastifyOptions: Parameters<typeof Fastify>[0] = {},
) => {
  const app = Fastify({ logger: false, ...fastifyOptions })
  // Static-config start flow: instance + published oauth2 catalog entry; the
  // managed-product lookup (a `findFirst` filtered on `name`) returns null;
  // the rate limiter reads an always-under-the-limit row.
  const prisma = {
    mcpServerInstance: { findFirst: async () => oauthInstance },
    mcpCatalogEntry: {
      findFirst: async ({ where }: { where: Record<string, unknown> }) =>
        where['name'] !== undefined ? null : oauthCatalogEntry,
    },
    $queryRaw: async () => [{ count: 1 }],
    $executeRaw: async () => 0,
    $transaction: async <T>(callback: (tx: unknown) => Promise<T>) => callback({
      $executeRaw: async () => 0,
      auditLog: { create: async () => ({}), findFirst: async () => null },
    }),
  }
  const oauthSecretStore: SecretStore = { put: async () => 'secret_stub' }
  registerMcpOAuthRoutes(app, {
    prisma: prisma as unknown as PrismaClient,
    config: {
      ...config,
      api: {
        ...config.api,
        rateLimit: { mcpOauthIp: { max: 100, windowMs: 60_000 } },
      },
    },
    rateLimiter: new RateLimiter(
      prisma as unknown as PrismaClient,
      { error: () => {} },
    ),
    requireActorContext: () => actorContext,
    requireOwner: () => false,
    oauthSecretStore,
    // In-memory no-op state store — the minted token is never taken back.
    oauthStateStore: {
      put: async () => {},
      take: async () => null,
    },
    oauthResolveHost: publicResolver,
  })
  return app
}

const startOAuthWith = (
  app: ReturnType<typeof makeApp>,
  headers: Record<string, string>,
) =>
  app.inject({
    method: 'POST',
    url: '/api/mcp/instances/instance-1/oauth/start',
    headers: {
      host: 'api.example.internal:5454',
      ...headers,
    },
  })

const redirectUriOf = (body: unknown): string => {
  const authorizationUrl = new URL(
    (body as { data: { authorizationUrl: string } }).data.authorizationUrl,
  )
  const redirectUri = authorizationUrl.searchParams.get('redirect_uri')
  assert.ok(redirectUri, 'authorization URL must carry redirect_uri')
  return redirectUri
}

// ─── resolver unit contract ─────────────────────────────────────────────────

test('resolvePublicOrigin prefers the configured api.publicUrl origin', () => {
  const origin = resolvePublicOrigin(
    { protocol: 'http', hostname: 'attacker.example' },
    {
      mode: 'hosted',
      api: { publicUrl: 'https://api.nessie.works/some/path?q=1' },
    },
  )
  assert.equal(origin, 'https://api.nessie.works')
})

test('resolvePublicOrigin fails loudly in selfHosted mode without api.publicUrl', () => {
  assert.throws(
    () =>
      resolvePublicOrigin(
        { protocol: 'http', hostname: 'attacker.example' },
        { mode: 'selfHosted', api: {} },
      ),
    (error: unknown) =>
      error instanceof PublicOriginConfigError
      && error.code === 'PUBLIC_ORIGIN_NOT_CONFIGURED'
      && error.message.includes('NESSIE_API_PUBLIC_URL'),
  )
})

test('resolvePublicOrigin fails loudly in hosted mode without api.publicUrl', () => {
  assert.throws(
    () =>
      resolvePublicOrigin(
        { protocol: 'https', hostname: 'nessie.internal' },
        { mode: 'hosted', api: {} },
      ),
    PublicOriginConfigError,
  )
})

test('resolvePublicOrigin rejects an unparsable configured publicUrl', () => {
  assert.throws(
    () =>
      resolvePublicOrigin(
        { protocol: 'http', hostname: 'localhost:5454' },
        { mode: 'hosted', api: { publicUrl: 'not-a-url' } },
      ),
    PublicOriginConfigError,
  )
})

test('resolvePublicOrigin in local mode falls back to trust-scoped request values', () => {
  const origin = resolvePublicOrigin(
    { protocol: 'https', hostname: 'nessie.test' },
    { mode: 'local', api: {} },
  )
  assert.equal(origin, 'https://nessie.test')
})

test('toPublicOrigin strips path, query, credentials, and default ports', () => {
  assert.equal(
    toPublicOrigin('https://user:pw@api.example.com:443/callback?x=1'),
    'https://api.example.com',
  )
  assert.equal(toPublicOrigin('not-a-url'), null)
})

// ─── start route: configured publicUrl wins over every header ───────────────

test('start with api.publicUrl configured ignores spoofed X-Forwarded-Proto/Host', async () => {
  const app = makeApp({
    mode: 'hosted',
    api: { publicUrl: 'https://api.nessie.works' },
  })
  const response = await startOAuthWith(app, {
    'x-forwarded-proto': 'https',
    'x-forwarded-host': 'attacker.example',
    host: 'attacker.example',
  })
  assert.equal(response.statusCode, 200, response.body)
  assert.equal(
    redirectUriOf(response.json()),
    'https://api.nessie.works/api/mcp/oauth/callback',
  )
  await app.close()
})

// ─── start route: production modes fail closed without config ───────────────

test('start in selfHosted mode without api.publicUrl fails with a config error', async () => {
  const app = makeApp({ mode: 'selfHosted', api: {} })
  const response = await startOAuthWith(app, {
    host: 'attacker.example',
    'x-forwarded-host': 'attacker.example',
  })
  assert.equal(response.statusCode, 500, response.body)
  const body = response.json() as { error?: { code?: string } }
  assert.equal(body.error?.code, 'PUBLIC_ORIGIN_NOT_CONFIGURED')
  await app.close()
})

test('start in hosted mode without api.publicUrl fails with a config error', async () => {
  const app = makeApp({ mode: 'hosted', api: {} })
  const response = await startOAuthWith(app, { host: 'api.example.internal' })
  assert.equal(response.statusCode, 500, response.body)
  const body = response.json() as { error?: { code?: string } }
  assert.equal(body.error?.code, 'PUBLIC_ORIGIN_NOT_CONFIGURED')
  await app.close()
})

// ─── start route: local mode honours only the trusted proxy boundary ────────

test('start in local mode ignores spoofed X-Forwarded-* on an untrusted peer', async () => {
  // trustedProxyHops 0 → Fastify({ trustProxy: false }): the forwarded
  // headers must NOT steer the minted origin.
  const app = makeApp({ mode: 'local', api: {} }, { trustProxy: false })
  const response = await startOAuthWith(app, {
    'x-forwarded-proto': 'https',
    'x-forwarded-host': 'attacker.example',
    host: 'api.example.internal:5454',
  })
  assert.equal(response.statusCode, 200, response.body)
  // Fastify's `request.hostname` is the trusted Host *name* (no port): the
  // minted URL is the host the browser actually used, still entirely
  // request-header-free beyond that.
  assert.equal(
    redirectUriOf(response.json()),
    'http://api.example.internal/api/mcp/oauth/callback',
  )
  await app.close()
})

test('start in local mode behind a trusted proxy uses the forwarded values', async () => {
  // trustProxy: true — the reverse proxy is trusted, so the forwarded
  // proto/host are what browsers actually see and must win over the direct
  // Host header.
  const app = makeApp({ mode: 'local', api: {} }, { trustProxy: true })
  const response = await startOAuthWith(app, {
    'x-forwarded-proto': 'https',
    'x-forwarded-host': 'nessie.test',
    host: 'internal:5454',
  })
  assert.equal(response.statusCode, 200, response.body)
  assert.equal(
    redirectUriOf(response.json()),
    'https://nessie.test/api/mcp/oauth/callback',
  )
  await app.close()
})
