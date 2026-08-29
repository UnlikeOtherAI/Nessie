import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import test from 'node:test'

import type {
  McpClientManager,
  McpConnectionId,
  McpToolDescriptor,
} from '@nessie/mcp-client'
import {
  McpOAuth2AuthConfigSchema,
  McpServerAuthConfigSchema,
  type AuthorizedActionContext,
} from '@nessie/schemas'
import type { PrismaClient } from '@prisma/client'

import type { McpCatalogEntryRow } from '../src/index.js'
import type { McpInstanceRow } from '../src/index.js'

import {
  MCP_OAUTH_ERROR_CODES,
  McpOAuthError,
  completeOAuth,
  createInMemoryStateStore,
  defaultTokenExchange,
  generateState,
  startOAuth,
  type ManagerFactory,
  type SecretStore,
  type TokenExchangeFn,
} from '../src/index.js'

/**
 * Unit coverage for the OAuth2 handshake helper (task #20). The store is
 * deliberately injected per-test so we never share state across tests, and
 * the token exchange + secret store are stubs — no real HTTP traffic, no
 * plaintext token material leaves the test process.
 *
 * `completeOAuth` finishes by probing the instance, and `probeConnection` runs
 * the SSRF guard with no injected resolver, so the MCP endpoint is a literal
 * public IP: a hostname there would put a real DNS lookup in this suite.
 * Authorization/token URLs keep their hostnames — those checks take
 * `publicResolver`.
 */

const ORG_A = '00000000-0000-4000-8000-00000000000a'
const USER_A = '00000000-0000-4000-8000-00000000000c'
const CIMD_URL = 'https://api.example/.well-known/oauth-client'
const MCP_ENDPOINT = 'https://93.184.216.34/mcp'
const publicResolver = async (): Promise<string[]> => ['93.184.216.34']

/**
 * A probe that never opens a socket. Every completion test needs one, because
 * storing the token is no longer the last thing `completeOAuth` does.
 */
const offlineProbe = (
  behaviour: { descriptors?: McpToolDescriptor[]; failWith?: string } = {},
): ManagerFactory => () =>
  ({
    open: async () => 'connection-1' as McpConnectionId,
    listTools: async () => {
      if (behaviour.failWith) throw new Error(behaviour.failWith)
      return behaviour.descriptors ?? []
    },
    close: async () => undefined,
    closeAll: async () => undefined,
  }) as unknown as McpClientManager

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
  defaultTransportConfig: { transport: 'http', url: MCP_ENDPOINT },
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

type CredentialUpsert = {
  instanceId: string
  principalType: string
  principalId: string
  credentialRef: string
}

const makePrismaStub = (options: StubOptions = {}): {
  prisma: PrismaClient
  upserts: CredentialUpsert[]
  /** Every `mcpServerInstance.update` the flow wrote, in order. */
  instanceUpdates: Record<string, unknown>[]
} => {
  const upserts: CredentialUpsert[] = []
  const instanceUpdates: Record<string, unknown>[] = []
  // Mutable: the credential this flow stores has to be readable by the probe
  // that follows it. A stub answering the pre-callback row would let a probe
  // pass while resolving nothing.
  let current = options.instance === undefined ? baseInstance : options.instance
  const catalogEntry = options.catalogEntry === undefined ? oauthCatalogEntry : options.catalogEntry

  const applyUpdate = (data: Record<string, unknown>): McpInstanceRow => {
    instanceUpdates.push(data)
    const plain = { ...data }
    // `healthFailureCount: { increment: 1 }` is a Prisma atomic op, not a value.
    delete plain.healthFailureCount
    current = { ...(current ?? baseInstance), ...plain } as McpInstanceRow
    return current
  }

  const prisma = {
    mcpServerInstance: {
      findFirst: async () => current,
      findUnique: async () => current,
      update: async ({ data }: { data: Record<string, unknown> }) => applyUpdate(data),
    },
    mcpCatalogEntry: {
      // `isManagedIntegrationCatalogEntry` is the only reader that filters by
      // name; answering null there keeps these fixtures user-managed.
      findFirst: async (args: { where?: { name?: unknown } }) =>
        args?.where?.name === undefined ? catalogEntry : null,
    },
    mcpServerCredentialOverride: {
      findUnique: async (args: {
        where: { instanceId_principalType_principalId: Record<string, string> }
      }) => {
        const key = args.where.instanceId_principalType_principalId
        return (
          upserts.find(
            (row) =>
              row.instanceId === key.instanceId
              && row.principalType === key.principalType
              && row.principalId === key.principalId,
          ) ?? null
        )
      },
      upsert: async ({ create }: { create: Record<string, string> }) => {
        upserts.push({
          instanceId: create.instanceId,
          principalType: create.principalType,
          principalId: create.principalId,
          credentialRef: create.credentialRef,
        })
        return { id: 'override-1', ...create, createdAt: new Date(), updatedAt: new Date() }
      },
    },
    $transaction: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> =>
      fn({
        mcpServerInstance: {
          update: async ({ data }: { data: Record<string, unknown> }) => applyUpdate(data),
        },
        toolRegistryEntry: {
          findMany: async () => [],
          upsert: async () => ({}),
          updateMany: async () => ({ count: 0 }),
        },
      }),
  }
  return { prisma: prisma as unknown as PrismaClient, upserts, instanceUpdates }
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
    resolveHost: publicResolver,
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
    resolveHost: publicResolver,
  })
  const record = await store.take(result.state)
  assert.ok(record)
  assert.equal(record?.instanceId, 'instance-1')
  assert.equal(record?.organizationId, ORG_A)
  assert.equal(record?.actorId, USER_A)
  const ttlMs = (record?.expiresAt ?? 0) - before
  // 10 minute TTL, allow some slack for execution time.
  assert.ok(ttlMs >= 9 * 60 * 1000, `ttl ${ttlMs} too short`)
  assert.ok(ttlMs <= 11 * 60 * 1000, `ttl ${ttlMs} too long`)
})

test('startOAuth static mode authorizes with PKCE S256 bound to the stored verifier', async () => {
  // A pre-registered client is not a reason to skip proof of possession: an
  // authorization code intercepted on the redirect must be worthless without
  // the verifier that never left this process.
  const { prisma } = makePrismaStub()
  const store = createInMemoryStateStore()
  const result = await startOAuth({
    prisma,
    store,
    instanceId: 'instance-1',
    actorContext,
    callbackUrl: 'https://app.example/api/mcp/oauth/callback',
    resolveHost: publicResolver,
  })

  const url = new URL(result.authorizationUrl)
  assert.equal(result.mode, 'static')
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256')
  const challenge = url.searchParams.get('code_challenge') ?? ''
  assert.ok(challenge.length > 20, 'no code_challenge on the authorize URL')

  const record = await store.take(result.state)
  const verifier = record?.codeVerifier ?? ''
  assert.ok(verifier.length >= 43, 'no verifier persisted for the callback')
  assert.equal(
    crypto.createHash('sha256').update(verifier).digest('base64url'),
    challenge,
  )
})

test('startOAuth static mode binds the token to the MCP server (RFC 8707 resource)', async () => {
  const { prisma } = makePrismaStub()
  const store = createInMemoryStateStore()
  const result = await startOAuth({
    prisma,
    store,
    instanceId: 'instance-1',
    actorContext,
    callbackUrl: 'https://app.example/api/mcp/oauth/callback',
    resolveHost: publicResolver,
  })

  const url = new URL(result.authorizationUrl)
  // Canonical form of the instance's own endpoint, so an authorization server
  // fronting several resources cannot be talked into minting a token for
  // another one.
  assert.equal(url.searchParams.get('resource'), MCP_ENDPOINT)
  const record = await store.take(result.state)
  assert.equal(record?.resource, MCP_ENDPOINT)
})

test('startOAuth static mode omits the resource when the endpoint is not an HTTP remote', async () => {
  // A resource indicator only means something for a remote URL. A transport we
  // cannot express as one is the probe's problem to report — not a reason to
  // refuse a sign-in the person just asked for.
  const { prisma } = makePrismaStub({
    catalogEntry: {
      ...oauthCatalogEntry,
      defaultTransportConfig: { transport: 'stdio', command: 'local-server' },
    },
  })
  const result = await startOAuth({
    prisma,
    store: createInMemoryStateStore(),
    instanceId: 'instance-1',
    actorContext,
    callbackUrl: 'https://app.example/api/mcp/oauth/callback',
    resolveHost: publicResolver,
  })
  const url = new URL(result.authorizationUrl)
  assert.equal(url.searchParams.get('resource'), null)
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256')
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
      resolveHost: publicResolver,
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
      resolveHost: publicResolver,
    })
  } catch (error) {
    thrown = error
  }
  assert.ok(thrown instanceof McpOAuthError)
  assert.equal((thrown as McpOAuthError).code, MCP_OAUTH_ERROR_CODES.NOT_OAUTH2)
})

test('startOAuth rejects unsafe OAuth authorization URLs', async () => {
  const { prisma } = makePrismaStub({
    catalogEntry: {
      ...oauthCatalogEntry,
      authConfig: {
        ...(oauthCatalogEntry.authConfig as Record<string, unknown>),
        authorizationUrl: 'http://127.0.0.1/auth',
      },
    },
  })
  await assert.rejects(
    () => startOAuth({
      prisma,
      store: createInMemoryStateStore(),
      instanceId: 'instance-1',
      actorContext,
      callbackUrl: 'https://app.example/cb',
      resolveHost: publicResolver,
    }),
    (error: unknown) =>
      error instanceof McpOAuthError
      && error.code === MCP_OAUTH_ERROR_CODES.URL_UNSAFE,
  )
})

test('startOAuth uses the published client metadata document instead of registering', async () => {
  // The wiring half of the preference order: a server advertising CIMD gets
  // the document URL as its client_id, and no client row is minted for it.
  const registered: string[] = []
  const prisma = {
    mcpServerInstance: { findFirst: async () => baseInstance },
    mcpCatalogEntry: {
      findFirst: async () => ({
        ...oauthCatalogEntry,
        name: 'dynamic-server',
        authConfig: { method: 'oauth2' },
        // Discovery is driven entirely by the injected `fetchImpl` below, and
        // this flow stops at the authorize URL, so a readable hostname costs
        // nothing here.
        defaultTransportConfig: { transport: 'http', url: 'https://provider.example/mcp' },
      }),
    },
    mcpOAuthClient: {
      findUnique: async () => null,
      upsert: async () => {
        registered.push('upsert')
        return {}
      },
    },
  } as unknown as PrismaClient

  const asMetadata = {
    issuer: 'https://provider.example',
    authorization_endpoint: 'https://provider.example/authorize',
    token_endpoint: 'https://provider.example/token',
    // Registration is on offer and must still lose to CIMD.
    registration_endpoint: 'https://provider.example/register',
    code_challenge_methods_supported: ['S256'],
    client_id_metadata_document_supported: true,
  }
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    if ((init?.method ?? 'GET') === 'POST' && url === 'https://provider.example/mcp') {
      return new Response('', {
        status: 401,
        headers: { 'www-authenticate': 'Bearer' },
      })
    }
    if (url === 'https://provider.example/.well-known/oauth-authorization-server') {
      return new Response(JSON.stringify(asMetadata), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    return new Response('not found', { status: 404 })
  }) as typeof fetch

  const store = createInMemoryStateStore()
  const result = await startOAuth({
    prisma,
    store,
    instanceId: 'instance-1',
    actorContext,
    callbackUrl: 'https://api.example/api/mcp/oauth/callback',
    resolveHost: publicResolver,
    discovery: { fetchImpl },
    clientResolution: {
      clientIdMetadataDocumentUrl: CIMD_URL,
    },
  })

  const url = new URL(result.authorizationUrl)
  assert.equal(result.mode, 'dynamic')
  assert.equal(url.searchParams.get('client_id'), CIMD_URL)
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256')
  assert.deepEqual(registered, [], 'CIMD must not register a client')
  const record = await store.take(result.state)
  assert.equal(record?.clientId, CIMD_URL)
  assert.equal(record?.clientSecretRef, undefined)
})

// ─── completeOAuth ──────────────────────────────────────────────────────────

const makeSecretStore = (): { store: SecretStore; calls: number; lastInput: unknown } => {
  const data: { calls: number; lastInput: unknown } = { calls: 0, lastInput: undefined }
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
  }
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
    resolveHost: publicResolver,
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
    resolveHost: publicResolver,
    managerFactory: offlineProbe(),
  })

  assert.equal(result.instanceId, 'instance-1')
  assert.equal(secret.calls, 1)
  assert.equal(secret.lastInput.accessToken, 'ya29.fake-access-token')
  assert.equal(secret.lastInput.refreshToken, 'r1.fake-refresh-token')
  // Per-user override created so multiple users sharing the same install
  // keep separate OAuth identities. The `credentialRef` lives on the override
  // row, never on the public API response (see "no credentialRef" test below).
  assert.equal(upserts.length, 1)
  assert.equal(upserts[0]?.principalType, 'user')
  assert.equal(upserts[0]?.principalId, USER_A)
  assert.equal(upserts[0]?.credentialRef, 'secret_test_ref_1')
})

test('completeOAuth response never leaks the internal credentialRef', async () => {
  // The `credentialRef` is an opaque pointer into the secret store; surfacing
  // it on the API boundary makes it possible for any caller that triggered
  // the OAuth flow to address other users' secrets. Pin the response shape
  // so a future refactor can't accidentally re-introduce it.
  const { prisma } = makePrismaStub()
  const store = createInMemoryStateStore()
  const start = await startOAuth({
    prisma,
    store,
    instanceId: 'instance-1',
    actorContext,
    callbackUrl: 'https://app.example/cb',
    resolveHost: publicResolver,
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
    resolveHost: publicResolver,
    managerFactory: offlineProbe(),
  })

  assert.deepEqual(Object.keys(result).sort(), ['instanceId'])
  assert.equal('credentialRef' in (result as Record<string, unknown>), false)
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
      resolveHost: publicResolver,
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

test('completeOAuth rejects unsafe OAuth token URLs before exchange', async () => {
  const store = createInMemoryStateStore()
  const state = generateState()
  store.put(state, {
    instanceId: 'instance-1',
    organizationId: ORG_A,
    actorId: USER_A,
    expiresAt: Date.now() + 60_000,
  })
  const { prisma } = makePrismaStub({
    catalogEntry: {
      ...oauthCatalogEntry,
      authConfig: {
        ...(oauthCatalogEntry.authConfig as Record<string, unknown>),
        tokenUrl: 'http://169.254.169.254/token',
      },
    },
  })
  const secret = makeSecretStore()
  let exchangeCalled = false

  await assert.rejects(
    () => completeOAuth({
      prisma,
      store,
      secretStore: secret.store,
      tokenExchange: async () => {
        exchangeCalled = true
        return { accessToken: 'should-not-run' }
      },
      state,
      code: 'auth-code-123',
      callbackUrl: 'https://app.example/cb',
      resolveHost: publicResolver,
    }),
    (error: unknown) =>
      error instanceof McpOAuthError
      && error.code === MCP_OAUTH_ERROR_CODES.URL_UNSAFE,
  )
  assert.equal(exchangeCalled, false)
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
    resolveHost: publicResolver,
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
    resolveHost: publicResolver,
    managerFactory: offlineProbe(),
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
      resolveHost: publicResolver,
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
      resolveHost: publicResolver,
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
    resolveHost: publicResolver,
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
      resolveHost: publicResolver,
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
    resolveHost: publicResolver,
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
      resolveHost: publicResolver,
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
    resolveHost: publicResolver,
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
    resolveHost: publicResolver,
    managerFactory: offlineProbe(),
  })

  assert.ok(captured)
  // Catalog → service plumbing must carry both halves of the OAuth2 client
  // credential through to the token exchange, otherwise the provider rejects
  // the authorization_code grant.
  assert.equal(captured?.clientId, 'test-client-id')
  assert.equal(captured?.clientSecret, 'test-client-secret')
})

test('completeOAuth redeems the static code with the verifier the challenge was built from', async () => {
  // RFC 7636 §4.6: an authorization server that recorded a challenge MUST
  // reject a token request that omits its verifier, and `startOAuth` sends a
  // challenge in static mode. A completion that leaves the verifier out
  // therefore fails every static-mode connector at the last step — and proves
  // nothing on a server lenient enough to let it through. An exchange stub
  // that ignores its arguments cannot catch that, so this one reads them.
  const { prisma } = makePrismaStub()
  const store = createInMemoryStateStore()
  const start = await startOAuth({
    prisma,
    store,
    instanceId: 'instance-1',
    actorContext,
    callbackUrl: 'https://app.example/cb',
    resolveHost: publicResolver,
  })
  const challenge = new URL(start.authorizationUrl).searchParams.get('code_challenge')
  assert.ok(challenge, 'startOAuth sent no challenge to verify against')

  const secret = makeSecretStore()
  let captured: Parameters<TokenExchangeFn>[0] | undefined
  await completeOAuth({
    prisma,
    store,
    secretStore: secret.store,
    tokenExchange: async (input) => {
      captured = input
      return { accessToken: 'ya29.fake', tokenType: 'Bearer' }
    },
    state: start.state,
    code: 'auth-code-123',
    callbackUrl: 'https://app.example/cb',
    resolveHost: publicResolver,
    managerFactory: offlineProbe(),
  })

  const verifier = captured?.codeVerifier
  assert.ok(verifier, 'no code_verifier reached the token endpoint')
  assert.equal(
    crypto.createHash('sha256').update(verifier).digest('base64url'),
    challenge,
    'the verifier sent does not hash to the challenge that was authorized',
  )
  // RFC 8707 — both legs of the flow must name the same audience, or the
  // server may issue a token for a resource the person never approved.
  assert.equal(captured?.resource, MCP_ENDPOINT)
})

test('completeOAuth probes with the stored credential so a sign-in ends connected', async () => {
  // Nothing else probes after the callback, so without this the instance stays
  // `pending_setup` — which the App Store renders as "connecting". The person
  // who just authorised successfully watches the poll exhaust and is told
  // nothing was saved, and no tools are ever projected.
  const { prisma, instanceUpdates } = makePrismaStub()
  const store = createInMemoryStateStore()
  const start = await startOAuth({
    prisma,
    store,
    instanceId: 'instance-1',
    actorContext,
    callbackUrl: 'https://app.example/cb',
    resolveHost: publicResolver,
  })
  const secret = makeSecretStore()
  const dialledWith: string[] = []

  await completeOAuth({
    prisma,
    store,
    secretStore: secret.store,
    secretResolver: {
      resolve: async (ref) => {
        dialledWith.push(ref)
        return 'ya29.fake-access-token'
      },
    },
    tokenExchange: stubTokenExchange(),
    state: start.state,
    code: 'auth-code-123',
    callbackUrl: 'https://app.example/cb',
    resolveHost: publicResolver,
    managerFactory: offlineProbe({
      descriptors: [{ name: 'search', description: 'Search' } as McpToolDescriptor],
    }),
  })

  assert.deepEqual(
    instanceUpdates.map((update) => update.lifecycleState),
    ['active'],
    'the connection did not leave pending_setup',
  )
  // The probe dialled with the credential this callback just minted, rather
  // than with whatever happened to be on the row before.
  assert.deepEqual(dialledWith, ['secret_test_ref_1'])
})

test('completeOAuth keeps the credential when the probe fails, and records the failure', async () => {
  // The authorization really did succeed and the token really is stored, so
  // failing the callback here would tell the person the opposite of what
  // happened. `testInstance` writes the failure onto the row instead, which is
  // where the connections surface reads it from.
  const { prisma, upserts, instanceUpdates } = makePrismaStub()
  const store = createInMemoryStateStore()
  const start = await startOAuth({
    prisma,
    store,
    instanceId: 'instance-1',
    actorContext,
    callbackUrl: 'https://app.example/cb',
    resolveHost: publicResolver,
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
    resolveHost: publicResolver,
    managerFactory: offlineProbe({ failWith: 'connect ECONNREFUSED' }),
  })

  assert.equal(result.instanceId, 'instance-1')
  assert.equal(upserts.length, 1, 'the credential was rolled back by a failed probe')
  assert.deepEqual(
    instanceUpdates.map((update) => update.lifecycleState),
    ['error'],
  )
})

test('defaultTokenExchange POSTs client_id + client_secret in the form body', async () => {
  // Capture the actual request body sent to the token endpoint by stubbing
  // global fetch. Proves the body conforms to RFC 6749 §4.1.3 + §2.3.1
  // (client credentials in the body, not Basic auth — we picked the body
  // form so a single POST carries everything and we don't have to special-
  // case providers that reject Basic).
  const originalFetch = globalThis.fetch
  let capturedBody: string | undefined
  let capturedHeaders: Headers | undefined
  globalThis.fetch = (async (
    _url: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    capturedBody = init?.body instanceof URLSearchParams
      ? init.body.toString()
      : typeof init?.body === 'string'
        ? init.body
        : ''
    // The exchange goes out through `pinnedFetch`, which normalizes headers
    // (`normalizeFetchHeaders`) into lowercase `[name, value]` entries before
    // handing them to the platform fetch — a valid `HeadersInit`, but not the
    // plain object the caller wrote. Read them back through `Headers` so the
    // assertion is about the header being sent, not about which shape the
    // transport happened to pass it in.
    capturedHeaders = new Headers(init?.headers)
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
      resolveHost: publicResolver,
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
    capturedHeaders?.get('content-type'),
    'application/x-www-form-urlencoded',
  )
})

test('McpOAuth2AuthConfigSchema accepts a dynamic (client-less) config', () => {
  const parsed = McpOAuth2AuthConfigSchema.parse({ method: 'oauth2' })
  assert.equal(parsed.method, 'oauth2')
  assert.equal(parsed.clientId, undefined)
  assert.deepEqual(parsed.scopes, [])
})

test('McpOAuth2AuthConfigSchema accepts a static config without clientSecret (public client)', () => {
  const parsed = McpOAuth2AuthConfigSchema.parse({
    method: 'oauth2',
    authorizationUrl: 'https://provider.example/auth',
    tokenUrl: 'https://provider.example/token',
    clientId: 'abc',
    scopes: [],
  })
  assert.equal(parsed.clientId, 'abc')
  assert.equal(parsed.clientSecret, undefined)
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

test('McpServerAuthConfigSchema discriminated union accepts dynamic oauth2 configs', () => {
  const parsed = McpServerAuthConfigSchema.parse({
    method: 'oauth2',
    authorizationUrl: 'https://provider.example/auth',
    tokenUrl: 'https://provider.example/token',
    scopes: [],
  })
  assert.equal(parsed.method, 'oauth2')
})
