import assert from 'node:assert/strict'
import test from 'node:test'

import type { AuthorizedActionContext } from '@nessie/schemas'
import type { PrismaClient } from '@prisma/client'

import type { McpCatalogEntryRow } from '../src/services/mcp-catalog.js'
import type { McpInstanceRow } from '../src/services/mcp-instances.js'
import {
  MCP_OAUTH_ERROR_CODES,
  McpOAuthError,
  completeOAuth,
  createInMemoryStateStore,
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

test('startOAuth returns an authorization URL with state, scope, redirect_uri', async () => {
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
