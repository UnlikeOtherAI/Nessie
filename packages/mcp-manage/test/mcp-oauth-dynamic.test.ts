import assert from 'node:assert/strict'
import test from 'node:test'

import type { AuthorizedActionContext } from '@nessie/schemas'
import type { PrismaClient } from '@prisma/client'

import {
  MCP_OAUTH_ERROR_CODES,
  McpOAuthError,
  completeOAuth,
  createInMemoryStateStore,
  startOAuth,
  type McpCatalogEntryRow,
  type McpInstanceRow,
  type SecretStore,
  type TokenExchangeFn,
} from '../src/index.js'

/**
 * Dynamic-mode OAuth: metadata discovery + DCR + PKCE, exercised end-to-end
 * with a scripted fetch and stubbed Prisma. IP-literal hosts pass the SSRF
 * guard without DNS.
 */

const ORG = '00000000-0000-4000-8000-00000000000a'
const USER = '00000000-0000-4000-8000-00000000000c'
const SERVER = 'https://93.184.216.34/mcp'
const AS = 'https://93.184.216.35'

const actorContext = {
  tenant: { organizationId: ORG },
  actor: { actorId: USER, actorType: 'user' },
  actionContext: {},
} as unknown as AuthorizedActionContext

const dynamicCatalogEntry = {
  id: 'catalog-1',
  organizationId: ORG,
  name: 'notion',
  label: 'Notion',
  description: '',
  protocol: 'http',
  authMethod: 'oauth2',
  authConfig: { method: 'oauth2' },
  defaultTransportConfig: { transport: 'http', url: SERVER },
  status: 'published',
} as unknown as McpCatalogEntryRow

const userInstance = {
  id: 'instance-1',
  catalogEntryId: 'catalog-1',
  organizationId: ORG,
  scopeType: 'user',
  scopeId: USER,
  credentialRef: null,
  transportConfig: {},
} as unknown as McpInstanceRow

type PrismaCapture = {
  clientUpserts: Array<Record<string, unknown>>
  instanceUpdates: Array<Record<string, unknown>>
  overrideUpserts: Array<Record<string, unknown>>
}

const makePrisma = (options: {
  instance?: McpInstanceRow
  existingClient?: { clientId: string; clientSecretRef: string | null; redirectUris: string[] } | null
  managedCatalog?: boolean
}): { prisma: PrismaClient; capture: PrismaCapture } => {
  const capture: PrismaCapture = {
    clientUpserts: [],
    instanceUpdates: [],
    overrideUpserts: [],
  }
  const prisma = {
    mcpServerInstance: {
      findFirst: async () => options.instance ?? userInstance,
      update: async (args: Record<string, unknown>) => {
        capture.instanceUpdates.push(args)
        return {}
      },
    },
    mcpCatalogEntry: {
      findFirst: async () =>
        options.managedCatalog
          ? {
              ...dynamicCatalogEntry,
              integratedProducts: [{ slug: 'deepsignal' }],
              name: 'deepsignal',
              organizationId: null,
              visibility: 'public',
            }
          : dynamicCatalogEntry,
    },
    mcpOAuthClient: {
      findUnique: async () => options.existingClient ?? null,
      upsert: async (args: { create: Record<string, unknown> }) => {
        capture.clientUpserts.push(args.create)
        return { ...args.create }
      },
    },
    mcpServerCredentialOverride: {
      upsert: async (args: { create: Record<string, unknown> }) => {
        capture.overrideUpserts.push(args.create)
        return { ...args.create }
      },
    },
  } as unknown as PrismaClient
  return { prisma, capture }
}

const discoveryFetch = (): typeof fetch =>
  (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    const method = init?.method ?? 'GET'
    if (method === 'POST' && url === SERVER) {
      return new Response('', {
        status: 401,
        headers: {
          'www-authenticate': `Bearer resource_metadata="https://93.184.216.34/.well-known/oauth-protected-resource/mcp"`,
        },
      })
    }
    if (url === 'https://93.184.216.34/.well-known/oauth-protected-resource/mcp') {
      return new Response(
        JSON.stringify({ resource: SERVER, authorization_servers: [AS] }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }
    if (url === `${AS}/.well-known/oauth-authorization-server`) {
      return new Response(
        JSON.stringify({
          issuer: AS,
          authorization_endpoint: `${AS}/authorize`,
          token_endpoint: `${AS}/token`,
          registration_endpoint: `${AS}/register`,
          code_challenge_methods_supported: ['S256'],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }
    if (method === 'POST' && url === `${AS}/register`) {
      return new Response(JSON.stringify({ client_id: 'dyn-client-1' }), {
        status: 201,
        headers: { 'content-type': 'application/json' },
      })
    }
    return new Response('not found', { status: 404 })
  }) as typeof fetch

const secretStore = (refs: string[]): SecretStore => ({
  put: async () => {
    const ref = `secret_oauth_test_${refs.length + 1}`
    refs.push(ref)
    return ref
  },
})

test('startOAuth dynamic mode discovers, registers a client, and builds a PKCE authorize URL', async () => {
  const { prisma, capture } = makePrisma({})
  const store = createInMemoryStateStore()
  const refs: string[] = []

  const result = await startOAuth({
    prisma,
    store,
    secretStore: secretStore(refs),
    instanceId: 'instance-1',
    actorContext,
    callbackUrl: 'https://api.example/api/mcp/oauth/callback',
    discovery: { fetchImpl: discoveryFetch() },
  })

  assert.equal(result.mode, 'dynamic')
  const url = new URL(result.authorizationUrl)
  assert.equal(url.origin + url.pathname, `${AS}/authorize`)
  assert.equal(url.searchParams.get('client_id'), 'dyn-client-1')
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256')
  assert.ok((url.searchParams.get('code_challenge') ?? '').length > 20)
  assert.equal(url.searchParams.get('resource'), SERVER)
  assert.equal(
    url.searchParams.get('redirect_uri'),
    'https://api.example/api/mcp/oauth/callback',
  )
  // Client persisted per (org, issuer).
  assert.equal(capture.clientUpserts.length, 1)
  assert.equal(capture.clientUpserts[0]?.clientId, 'dyn-client-1')
  assert.equal(capture.clientUpserts[0]?.issuer, AS)

  // State carries everything the callback needs.
  const record = await store.take(result.state)
  assert.equal(record?.mode, 'dynamic')
  assert.equal(record?.clientId, 'dyn-client-1')
  assert.equal(record?.tokenEndpoint, `${AS}/token`)
  assert.ok((record?.codeVerifier ?? '').length >= 43)
})

test('startOAuth dynamic mode reuses an existing registered client for the same issuer', async () => {
  const { prisma, capture } = makePrisma({
    existingClient: {
      clientId: 'existing-client',
      clientSecretRef: null,
      redirectUris: ['https://api.example/api/mcp/oauth/callback'],
    },
  })
  const result = await startOAuth({
    prisma,
    store: createInMemoryStateStore(),
    instanceId: 'instance-1',
    actorContext,
    callbackUrl: 'https://api.example/api/mcp/oauth/callback',
    discovery: { fetchImpl: discoveryFetch() },
  })
  const url = new URL(result.authorizationUrl)
  assert.equal(url.searchParams.get('client_id'), 'existing-client')
  assert.equal(capture.clientUpserts.length, 0)
})

test('startOAuth refuses a managed first-party product before discovery', async () => {
  const { prisma, capture } = makePrisma({ managedCatalog: true })
  let discovered = false

  await assert.rejects(
    startOAuth({
      prisma,
      store: createInMemoryStateStore(),
      instanceId: 'instance-1',
      actorContext,
      callbackUrl: 'https://api.example/api/mcp/oauth/callback',
      discovery: {
        fetchImpl: (async () => {
          discovered = true
          throw new Error('managed OAuth must not reach discovery')
        }) as typeof fetch,
      },
    }),
    (error: unknown) =>
      error instanceof McpOAuthError
      && error.code === MCP_OAUTH_ERROR_CODES.NOT_OAUTH2,
  )

  assert.equal(discovered, false)
  assert.equal(capture.clientUpserts.length, 0)
})

test('completeOAuth dynamic mode exchanges with PKCE + resource and credentials the user instance', async () => {
  const { prisma, capture } = makePrisma({})
  const store = createInMemoryStateStore()
  const refs: string[] = []
  await store.put('state-1', {
    instanceId: 'instance-1',
    organizationId: ORG,
    actorId: USER,
    expiresAt: Date.now() + 60_000,
    mode: 'dynamic',
    redirectUri: 'https://api.example/api/mcp/oauth/callback',
    codeVerifier: 'verifier-abc',
    clientId: 'dyn-client-1',
    tokenEndpoint: `${AS}/token`,
    resource: SERVER,
  })

  let exchanged: Record<string, unknown> = {}
  const tokenExchange: TokenExchangeFn = async (input) => {
    exchanged = input as unknown as Record<string, unknown>
    return { accessToken: 'at-1', refreshToken: 'rt-1', expiresIn: 3600 }
  }

  const result = await completeOAuth({
    prisma,
    store,
    secretStore: secretStore(refs),
    tokenExchange,
    state: 'state-1',
    code: 'code-1',
    callbackUrl: 'https://api.example/api/mcp/oauth/callback',
  })

  assert.equal(result.instanceId, 'instance-1')
  assert.equal(exchanged['tokenUrl'], `${AS}/token`)
  assert.equal(exchanged['clientId'], 'dyn-client-1')
  assert.equal(exchanged['codeVerifier'], 'verifier-abc')
  assert.equal(exchanged['resource'], SERVER)
  // User-scope instance owned by the actor → token becomes the instance
  // credential (probes work immediately); no override row.
  assert.equal(capture.instanceUpdates.length, 1)
  assert.equal(capture.overrideUpserts.length, 0)
  assert.equal(refs.length, 1)
})

test('completeOAuth stores a per-user override for shared instances', async () => {
  const sharedInstance = {
    ...userInstance,
    scopeType: 'organization',
    scopeId: ORG,
  } as unknown as McpInstanceRow
  const { prisma, capture } = makePrisma({ instance: sharedInstance })
  const store = createInMemoryStateStore()
  await store.put('state-2', {
    instanceId: 'instance-1',
    organizationId: ORG,
    actorId: USER,
    expiresAt: Date.now() + 60_000,
    mode: 'dynamic',
    redirectUri: 'https://api.example/cb',
    codeVerifier: 'v',
    clientId: 'c',
    tokenEndpoint: `${AS}/token`,
    resource: SERVER,
  })
  await completeOAuth({
    prisma,
    store,
    secretStore: secretStore([]),
    tokenExchange: async () => ({ accessToken: 'at' }),
    state: 'state-2',
    code: 'code',
    callbackUrl: 'https://api.example/cb',
  })
  assert.equal(capture.instanceUpdates.length, 0)
  assert.equal(capture.overrideUpserts.length, 1)
  assert.equal(capture.overrideUpserts[0]?.principalType, 'user')
  assert.equal(capture.overrideUpserts[0]?.principalId, USER)
})
