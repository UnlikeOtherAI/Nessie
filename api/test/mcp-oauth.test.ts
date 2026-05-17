import assert from 'node:assert/strict'
import test from 'node:test'

import Fastify from 'fastify'

import {
  McpOAuth2AuthConfigSchema,
  McpServerAuthConfigSchema,
  type AuthorizedActionContext,
} from '@nessie/schemas'
import type { PrismaClient } from '@prisma/client'

import { registerMcpRoutes } from '../src/routes/mcp.js'
import type { McpCatalogEntryRow } from '../src/services/mcp-catalog.js'
import type { McpInstanceRow } from '../src/services/mcp-instances.js'

import {
  MCP_OAUTH_ERROR_CODES,
  McpOAuthError,
  completeOAuth,
  createInMemoryStateStore,
  defaultTokenExchange,
  generateState,
  startOAuth,
  type SecretStore,
  type TokenExchangeFn,
} from '../src/services/mcp-oauth.js'

/**
 * Unit coverage for the OAuth2 handshake helper (task #20). The store is
 * deliberately injected per-test so we never share state across tests, and
 * the token exchange + secret store are stubs — no real HTTP traffic, no
 * plaintext token material leaves the test process.
 */

const ORG_A = '00000000-0000-4000-8000-00000000000a'
const USER_A = '00000000-0000-4000-8000-00000000000c'

const actorContext: AuthorizedActionContext = {
  tenant: {
    organizationId: ORG_A,
    organizationName: 'test-org',
  },
  actor: {
    actorId: USER_A,
    actorType: 'user',
    actorEmail: 'a@example.com',
    actorName: 'A',
  },
  actionContext: {},
} as unknown as AuthorizedActionContext

const baseInstance: McpInstanceRow = {
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

const oauthCatalogEntry: McpCatalogEntryRow = {
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
    clientSecret: 'test-client-secret',
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

const noneCatalogEntry: McpCatalogEntryRow = {
  ...oauthCatalogEntry,
  authMethod: 'none',
  authConfig: { method: 'none' },
}

type StubOptions = {
  instance?: McpInstanceRow | null
  catalogEntry?: McpCatalogEntryRow | null
}

const makePrismaStub = (options: StubOptions = {}): {
  prisma: PrismaClient
  upserts: Array<{ instanceId: string; principalType: string; principalId: string; credentialRef: string }>
} => {
  const upserts: Array<{
    instanceId: string
    principalType: string
    principalId: string
    credentialRef: string
  }> = []
  const instance = options.instance === undefined ? baseInstance : options.instance
  const catalogEntry = options.catalogEntry === undefined ? oauthCatalogEntry : options.catalogEntry
  const prisma = {
    mcpServerInstance: {
      findFirst: async () => instance,
    },
    mcpCatalogEntry: {
      findFirst: async () => catalogEntry,
    },
    mcpServerCredentialOverride: {
      upsert: async ({ create }: { create: any }) => {
        upserts.push({
          instanceId: create.instanceId,
          principalType: create.principalType,
          principalId: create.principalId,
          credentialRef: create.credentialRef,
        })
        return { id: 'override-1', ...create, createdAt: new Date(), updatedAt: new Date() }
      },
    },
  }
  return { prisma: prisma as unknown as PrismaClient, upserts }
}

// ─── generateState ──────────────────────────────────────────────────────────

test('generateState mints cryptographically random base64url tokens', () => {
  const a = generateState()
  const b = generateState()
  assert.notEqual(a, b)
  // 32 random bytes → 43 base64url chars (no padding).
  assert.equal(a.length, 43)
  assert.match(a, /^[A-Za-z0-9_-]+$/)
})

// ─── startOAuth ─────────────────────────────────────────────────────────────

test('startOAuth returns an authorization URL with state, scope, redirect_uri, client_id', async () => {
  const { prisma } = makePrismaStub()
  const store = createInMemoryStateStore()
  const result = await startOAuth({
    prisma,
    store,
    instanceId: 'instance-1',
    actorContext,
    callbackUrl: 'https://app.example/api/mcp/oauth/callback',
  })
  const url = new URL(result.authorizationUrl)
  assert.equal(url.origin + url.pathname, 'https://provider.example/auth')
  assert.equal(url.searchParams.get('state'), result.state)
  assert.equal(url.searchParams.get('response_type'), 'code')
  assert.equal(
    url.searchParams.get('redirect_uri'),
    'https://app.example/api/mcp/oauth/callback',
  )
  assert.equal(url.searchParams.get('scope'), 'read:repo')
  // RFC 6749 §4.1.1 — `client_id` is REQUIRED on the authorization request.
  assert.equal(url.searchParams.get('client_id'), 'test-client-id')
})

test('startOAuth stores the state with a 10-minute TTL for callback verification', async () => {
  const { prisma } = makePrismaStub()
  const store = createInMemoryStateStore()
  const before = Date.now()
  const result = await startOAuth({
    prisma,
    store,
    instanceId: 'instance-1',
    actorContext,
    callbackUrl: 'https://app.example/api/mcp/oauth/callback',
  })
  const record = store.take(result.state)
  assert.ok(record)
  assert.equal(record?.instanceId, 'instance-1')
  assert.equal(record?.organizationId, ORG_A)
  assert.equal(record?.actorId, USER_A)
  const ttlMs = (record?.expiresAt ?? 0) - before
  // 10 minute TTL, allow some slack for execution time.
  assert.ok(ttlMs >= 9 * 60 * 1000, `ttl ${ttlMs} too short`)
  assert.ok(ttlMs <= 11 * 60 * 1000, `ttl ${ttlMs} too long`)
})

test('startOAuth throws INSTANCE_NOT_FOUND when the instance is missing', async () => {
  const { prisma } = makePrismaStub({ instance: null })
  let thrown: unknown
  try {
    await startOAuth({
      prisma,
      store: createInMemoryStateStore(),
      instanceId: 'missing',
      actorContext,
      callbackUrl: 'https://app.example/cb',
    })
  } catch (error) {
    thrown = error
  }
  assert.ok(thrown instanceof McpOAuthError)
  assert.equal(
    (thrown as McpOAuthError).code,
    MCP_OAUTH_ERROR_CODES.INSTANCE_NOT_FOUND,
  )
})

test('startOAuth throws NOT_OAUTH2 when the catalog entry uses a different auth method', async () => {
  const { prisma } = makePrismaStub({ catalogEntry: noneCatalogEntry })
  let thrown: unknown
  try {
    await startOAuth({
      prisma,
      store: createInMemoryStateStore(),
      instanceId: 'instance-1',
      actorContext,
      callbackUrl: 'https://app.example/cb',
    })
  } catch (error) {
    thrown = error
  }
  assert.ok(thrown instanceof McpOAuthError)
  assert.equal((thrown as McpOAuthError).code, MCP_OAUTH_ERROR_CODES.NOT_OAUTH2)
})

// ─── completeOAuth ──────────────────────────────────────────────────────────

const makeSecretStore = (): { store: SecretStore; calls: number; lastInput: any } => {
  const data = { calls: 0, lastInput: undefined as any }
  const store: SecretStore = {
    put: async (input) => {
      data.calls += 1
      data.lastInput = input
      return 'secret_test_ref_1'
    },
  }
  return {
    store,
    get calls() {
      return data.calls
    },
    get lastInput() {
      return data.lastInput
    },
  } as any
}

const stubTokenExchange = (
  response: Awaited<ReturnType<TokenExchangeFn>> = {
    accessToken: 'ya29.fake-access-token',
    refreshToken: 'r1.fake-refresh-token',
    expiresIn: 3600,
    tokenType: 'Bearer',
  },
): TokenExchangeFn => async () => response

test('completeOAuth exchanges code, persists secret, links per-user override', async () => {
  const { prisma, upserts } = makePrismaStub()
  const store = createInMemoryStateStore()
  // Mint a real state via startOAuth so we test the end-to-end token shape.
  const start = await startOAuth({
    prisma,
    store,
    instanceId: 'instance-1',
    actorContext,
    callbackUrl: 'https://app.example/cb',
  })
  const secret = makeSecretStore()

  const result = await completeOAuth({
    prisma,
    store,
    secretStore: secret.store,
    tokenExchange: stubTokenExchange(),
    state: start.state,
    code: 'auth-code-123',
    callbackUrl: 'https://app.example/cb',
  })

  assert.equal(result.instanceId, 'instance-1')
  assert.equal(result.credentialRef, 'secret_test_ref_1')
  assert.equal(secret.calls, 1)
  assert.equal(secret.lastInput.accessToken, 'ya29.fake-access-token')
  assert.equal(secret.lastInput.refreshToken, 'r1.fake-refresh-token')
  // Per-user override created so multiple users sharing the same install
  // keep separate OAuth identities.
  assert.equal(upserts.length, 1)
  assert.equal(upserts[0]?.principalType, 'user')
  assert.equal(upserts[0]?.principalId, USER_A)
  assert.equal(upserts[0]?.credentialRef, 'secret_test_ref_1')
})

test('completeOAuth rejects an unknown state token', async () => {
  const { prisma } = makePrismaStub()
  const store = createInMemoryStateStore()
  const secret = makeSecretStore()
  let thrown: unknown
  try {
    await completeOAuth({
      prisma,
      store,
      secretStore: secret.store,
      tokenExchange: stubTokenExchange(),
      state: 'totally-fake-token',
      code: 'auth-code-123',
      callbackUrl: 'https://app.example/cb',
    })
  } catch (error) {
    thrown = error
  }
  assert.ok(thrown instanceof McpOAuthError)
  assert.equal(
    (thrown as McpOAuthError).code,
    MCP_OAUTH_ERROR_CODES.STATE_INVALID,
  )
})

test('completeOAuth treats state as single-use (replay rejected)', async () => {
  const { prisma } = makePrismaStub()
  const store = createInMemoryStateStore()
  const start = await startOAuth({
    prisma,
    store,
    instanceId: 'instance-1',
    actorContext,
    callbackUrl: 'https://app.example/cb',
  })
  const secret = makeSecretStore()

  // First exchange succeeds.
  await completeOAuth({
    prisma,
    store,
    secretStore: secret.store,
    tokenExchange: stubTokenExchange(),
    state: start.state,
    code: 'auth-code-123',
    callbackUrl: 'https://app.example/cb',
  })

  // Second exchange with the same state must be rejected.
  let thrown: unknown
  try {
    await completeOAuth({
      prisma,
      store,
      secretStore: secret.store,
      tokenExchange: stubTokenExchange(),
      state: start.state,
      code: 'auth-code-123',
      callbackUrl: 'https://app.example/cb',
    })
  } catch (error) {
    thrown = error
  }
  assert.ok(thrown instanceof McpOAuthError)
  assert.equal(
    (thrown as McpOAuthError).code,
    MCP_OAUTH_ERROR_CODES.STATE_INVALID,
  )
})

test('completeOAuth rejects an expired state token', async () => {
  const { prisma } = makePrismaStub()
  // Hand-roll a store whose ONLY entry is already-expired so we don't have to
  // wait 10 minutes in a unit test.
  const store = createInMemoryStateStore()
  const token = generateState()
  store.put(token, {
    instanceId: 'instance-1',
    organizationId: ORG_A,
    actorId: USER_A,
    expiresAt: Date.now() - 1000,
  })
  const secret = makeSecretStore()

  let thrown: unknown
  try {
    await completeOAuth({
      prisma,
      store,
      secretStore: secret.store,
      tokenExchange: stubTokenExchange(),
      state: token,
      code: 'auth-code-123',
      callbackUrl: 'https://app.example/cb',
    })
  } catch (error) {
    thrown = error
  }
  assert.ok(thrown instanceof McpOAuthError)
  assert.equal(
    (thrown as McpOAuthError).code,
    MCP_OAUTH_ERROR_CODES.STATE_INVALID,
  )
})

test('completeOAuth surfaces token-response failure when access_token is missing', async () => {
  const { prisma } = makePrismaStub()
  const store = createInMemoryStateStore()
  const start = await startOAuth({
    prisma,
    store,
    instanceId: 'instance-1',
    actorContext,
    callbackUrl: 'https://app.example/cb',
  })
  const secret = makeSecretStore()
  const badExchange: TokenExchangeFn = async () => {
    throw new McpOAuthError(
      MCP_OAUTH_ERROR_CODES.TOKEN_RESPONSE_INVALID,
      'Token response missing access_token',
    )
  }

  let thrown: unknown
  try {
    await completeOAuth({
      prisma,
      store,
      secretStore: secret.store,
      tokenExchange: badExchange,
      state: start.state,
      code: 'auth-code-123',
      callbackUrl: 'https://app.example/cb',
    })
  } catch (error) {
    thrown = error
  }
  assert.ok(thrown instanceof McpOAuthError)
  assert.equal(
    (thrown as McpOAuthError).code,
    MCP_OAUTH_ERROR_CODES.TOKEN_RESPONSE_INVALID,
  )
})

test('completeOAuth rejects missing code parameter', async () => {
  const { prisma } = makePrismaStub()
  const store = createInMemoryStateStore()
  const start = await startOAuth({
    prisma,
    store,
    instanceId: 'instance-1',
    actorContext,
    callbackUrl: 'https://app.example/cb',
  })
  const secret = makeSecretStore()

  let thrown: unknown
  try {
    await completeOAuth({
      prisma,
      store,
      secretStore: secret.store,
      tokenExchange: stubTokenExchange(),
      state: start.state,
      code: '',
      callbackUrl: 'https://app.example/cb',
    })
  } catch (error) {
    thrown = error
  }
  assert.ok(thrown instanceof McpOAuthError)
  assert.equal(
    (thrown as McpOAuthError).code,
    MCP_OAUTH_ERROR_CODES.TOKEN_EXCHANGE_FAILED,
  )
})

// ─── RFC 6749 client_id / client_secret coverage (task #37) ─────────────────

test('completeOAuth forwards client_id + client_secret to the token exchange', async () => {
  const { prisma } = makePrismaStub()
  const store = createInMemoryStateStore()
  const start = await startOAuth({
    prisma,
    store,
    instanceId: 'instance-1',
    actorContext,
    callbackUrl: 'https://app.example/cb',
  })
  const secret = makeSecretStore()
  let captured: Parameters<TokenExchangeFn>[0] | undefined
  const recordingExchange: TokenExchangeFn = async (input) => {
    captured = input
    return {
      accessToken: 'ya29.fake',
      refreshToken: 'r1.fake',
      expiresIn: 3600,
      tokenType: 'Bearer',
    }
  }

  await completeOAuth({
    prisma,
    store,
    secretStore: secret.store,
    tokenExchange: recordingExchange,
    state: start.state,
    code: 'auth-code-123',
    callbackUrl: 'https://app.example/cb',
  })

  assert.ok(captured)
  // Catalog → service plumbing must carry both halves of the OAuth2 client
  // credential through to the token exchange, otherwise the provider rejects
  // the authorization_code grant.
  assert.equal(captured?.clientId, 'test-client-id')
  assert.equal(captured?.clientSecret, 'test-client-secret')
})

test('defaultTokenExchange POSTs client_id + client_secret in the form body', async () => {
  // Capture the actual request body sent to the token endpoint by stubbing
  // global fetch. Proves the body conforms to RFC 6749 §4.1.3 + §2.3.1
  // (client credentials in the body, not Basic auth — we picked the body
  // form so a single POST carries everything and we don't have to special-
  // case providers that reject Basic).
  const originalFetch = globalThis.fetch
  let capturedBody: string | undefined
  let capturedHeaders: Record<string, string> | undefined
  globalThis.fetch = (async (
    _url: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    capturedBody = init?.body instanceof URLSearchParams
      ? init.body.toString()
      : typeof init?.body === 'string'
        ? init.body
        : ''
    capturedHeaders = (init?.headers ?? {}) as Record<string, string>
    return new Response(
      JSON.stringify({
        access_token: 'ya29.fake',
        token_type: 'Bearer',
        expires_in: 3600,
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    )
  }) as typeof globalThis.fetch

  try {
    await defaultTokenExchange({
      tokenUrl: 'https://provider.example/token',
      code: 'auth-code-xyz',
      redirectUri: 'https://app.example/cb',
      clientId: 'client-abc',
      clientSecret: 'shh-secret',
    })
  } finally {
    globalThis.fetch = originalFetch
  }

  assert.ok(capturedBody, 'fetch was not called with a body')
  const parsedBody = new URLSearchParams(capturedBody)
  assert.equal(parsedBody.get('grant_type'), 'authorization_code')
  assert.equal(parsedBody.get('code'), 'auth-code-xyz')
  assert.equal(parsedBody.get('redirect_uri'), 'https://app.example/cb')
  assert.equal(parsedBody.get('client_id'), 'client-abc')
  assert.equal(parsedBody.get('client_secret'), 'shh-secret')
  assert.equal(
    capturedHeaders?.['Content-Type'],
    'application/x-www-form-urlencoded',
  )
})

test('McpOAuth2AuthConfigSchema rejects configs missing clientId', () => {
  let thrown: unknown
  try {
    McpOAuth2AuthConfigSchema.parse({
      method: 'oauth2',
      authorizationUrl: 'https://provider.example/auth',
      tokenUrl: 'https://provider.example/token',
      clientSecret: 'shh',
      scopes: [],
    })
  } catch (error) {
    thrown = error
  }
  assert.ok(thrown, 'expected schema to reject config missing clientId')
})

test('McpOAuth2AuthConfigSchema rejects configs missing clientSecret', () => {
  let thrown: unknown
  try {
    McpOAuth2AuthConfigSchema.parse({
      method: 'oauth2',
      authorizationUrl: 'https://provider.example/auth',
      tokenUrl: 'https://provider.example/token',
      clientId: 'abc',
      scopes: [],
    })
  } catch (error) {
    thrown = error
  }
  assert.ok(thrown, 'expected schema to reject config missing clientSecret')
})

test('McpOAuth2AuthConfigSchema rejects empty clientId / clientSecret strings', () => {
  for (const bad of [
    { clientId: '', clientSecret: 'shh' },
    { clientId: 'abc', clientSecret: '' },
  ]) {
    let thrown: unknown
    try {
      McpOAuth2AuthConfigSchema.parse({
        method: 'oauth2',
        authorizationUrl: 'https://provider.example/auth',
        tokenUrl: 'https://provider.example/token',
        scopes: [],
        ...bad,
      })
    } catch (error) {
      thrown = error
    }
    assert.ok(thrown, `expected schema to reject ${JSON.stringify(bad)}`)
  }
})

test('McpServerAuthConfigSchema discriminated union enforces oauth2 client credentials', () => {
  let thrown: unknown
  try {
    McpServerAuthConfigSchema.parse({
      method: 'oauth2',
      authorizationUrl: 'https://provider.example/auth',
      tokenUrl: 'https://provider.example/token',
      scopes: [],
    })
  } catch (error) {
    thrown = error
  }
  assert.ok(thrown, 'discriminated union must reject oauth2 without client creds')
})

// ─── registerMcpRoutes production guard (task #38) ──────────────────────────

const makeRouteHelpers = () => {
  const { prisma } = makePrismaStub()
  return {
    prisma,
    requireActorContext: () => null,
    requireOwner: () => false,
  }
}

test('registerMcpRoutes throws when NODE_ENV=production and no SecretStore is wired', () => {
  const original = process.env.NODE_ENV
  process.env.NODE_ENV = 'production'
  try {
    const app = Fastify({ logger: false })
    assert.throws(
      () => registerMcpRoutes(app, makeRouteHelpers()),
      /OAuth SecretStore not configured/,
    )
  } finally {
    if (original === undefined) delete process.env.NODE_ENV
    else process.env.NODE_ENV = original
  }
})

test('registerMcpRoutes falls back to stub with a loud warning outside production', () => {
  const original = process.env.NODE_ENV
  process.env.NODE_ENV = 'development'
  const warnings: string[] = []
  try {
    const app = Fastify({ logger: false })
    // Capture the loud warning emitted by the fallback path.
    app.log.warn = ((msg: unknown) => {
      warnings.push(typeof msg === 'string' ? msg : JSON.stringify(msg))
    }) as typeof app.log.warn
    registerMcpRoutes(app, makeRouteHelpers())
    assert.ok(
      warnings.some((w) => w.includes('No OAuth SecretStore configured')),
      `expected loud fallback warning, got: ${JSON.stringify(warnings)}`,
    )
  } finally {
    if (original === undefined) delete process.env.NODE_ENV
    else process.env.NODE_ENV = original
  }
})

test('registerMcpRoutes accepts an explicit SecretStore in production without throwing', () => {
  const original = process.env.NODE_ENV
  process.env.NODE_ENV = 'production'
  try {
    const app = Fastify({ logger: false })
    const explicitStore: SecretStore = { put: async () => 'secret_explicit_1' }
    assert.doesNotThrow(() =>
      registerMcpRoutes(app, { ...makeRouteHelpers(), oauthSecretStore: explicitStore }),
    )
  } finally {
    if (original === undefined) delete process.env.NODE_ENV
    else process.env.NODE_ENV = original
  }
})
