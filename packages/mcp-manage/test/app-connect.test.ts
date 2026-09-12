import assert from 'node:assert/strict'
import test from 'node:test'

import type { McpToolDescriptor } from '@nessie/mcp-client'
import {
  MCP_OAUTH_ERROR_CODES,
  McpOAuthError,
  completeOAuth,
} from '../src/index.js'
import {
  APP_CONNECT_ERROR_CODES,
  AppConnectError,
  chooseConnectStep,
  mapHandshakeError,
  resolveConnection,
  runConnectHandshake,
} from '../src/apps/app-connect.js'
import { deriveConnectionStatus } from '../src/apps/app-connections.js'
import type { McpCatalogEntryRow } from '../src/index.js'
import {
  MEMBER,
  ORG,
  PROJECT,
  catalogEntry,
  instanceRow,
  makeAppConnectStub,
} from './app-connect-test-support.js'

/**
 * The universal Connect flow.
 *
 * What is worth testing here is the one thing Connect actually decides — probe,
 * sign in, or ask for a key — plus the two boundaries it owns: that an upstream
 * transport message never becomes a member-facing error, and that reaching an
 * existing connection is a different right from creating one.
 *
 * Everything else in the flow (`createInstance`'s scope/lock/SSRF guards,
 * `testInstance`'s projection, `startOAuth`'s PKCE and discovery) is covered by
 * the suites that own those functions; re-asserting them here would only test
 * that the orchestration calls them, which the types already state.
 *
 * Endpoints are literal public IPs so the SSRF guard resolves nothing: every
 * test in this file is offline.
 */
// ─── The decision ───────────────────────────────────────────────────────────

test('chooseConnectStep: an unauthenticated server just gets probed', () => {
  assert.equal(chooseConnectStep('none', false), 'probe')
  assert.equal(chooseConnectStep('none', true), 'probe')
  // Reconnecting a server with no auth has nothing to re-authorise.
  assert.equal(chooseConnectStep('none', false, true), 'probe')
})

test('chooseConnectStep: OAuth signs in until there is a grant, then probes', () => {
  assert.equal(chooseConnectStep('oauth2', false), 'oauth')
  assert.equal(chooseConnectStep('oauth2', true), 'probe')
})

test('chooseConnectStep: reconnect re-authorises rather than probing a doubtful grant', () => {
  assert.equal(chooseConnectStep('oauth2', true, true), 'oauth')
})

test('chooseConnectStep: a credentialled server asks for its key exactly once', () => {
  for (const method of ['bearer', 'api_key', 'basic'] as const) {
    assert.equal(chooseConnectStep(method, false), 'secret')
    // Once a key exists the probe runs, so a wrong key fails visibly at the
    // server instead of looping back to the same dialog forever.
    assert.equal(chooseConnectStep(method, true), 'probe')
    // Reconnect re-authorises OAuth only; there is nothing to re-authorise here.
    assert.equal(chooseConnectStep(method, true, true), 'probe')
  }
})

// ─── Handshake ──────────────────────────────────────────────────────────────

test('a clean handshake on an open server reports connected', async () => {
  const { ctx } = makeAppConnectStub({
    probe: { descriptors: [{ name: 'search', description: 'Search' } as McpToolDescriptor] },
  })
  const outcome = await runConnectHandshake(
    ctx,
    { label: 'Acme', authMethod: 'none' },
    instanceRow(),
  )
  assert.deepEqual(outcome, { status: 'connected', connectionId: 'instance-1' })
})

test('a server that wants a key is not probed, and no connection is claimed', async () => {
  const { ctx, updates } = makeAppConnectStub()
  const outcome = await runConnectHandshake(
    ctx,
    { label: 'Acme', authMethod: 'bearer' },
    instanceRow(),
  )
  assert.deepEqual(outcome, { status: 'needs_secret', connectionId: 'instance-1' })
  // Nothing was dialled, so nothing marked the connection as failed.
  assert.equal(updates.length, 0)
})

test('an unreachable server never leaks the upstream transport message', async () => {
  const { ctx } = makeAppConnectStub({
    probe: { failWith: 'connect ECONNREFUSED https://internal.acme.example/mcp' },
  })
  await assert.rejects(
    runConnectHandshake(ctx, { label: 'Acme', authMethod: 'none' }, instanceRow()),
    (error: unknown) => {
      assert.ok(error instanceof AppConnectError)
      assert.equal(error.code, APP_CONNECT_ERROR_CODES.SERVER_UNREACHABLE)
      assert.equal(error.message, "We couldn't reach Acme's server.")
      assert.ok(!error.message.includes('internal.acme.example'))
      return true
    },
  )
})

test('a provider that denies client registration names its approval requirement', () => {
  assert.throws(
    () => mapHandshakeError(
      new McpOAuthError(
        MCP_OAUTH_ERROR_CODES.CLIENT_APPROVAL_REQUIRED,
        'Dynamic client registration failed: HTTP 403',
      ),
      'Figma MCP Server',
    ),
    (error: unknown) => {
      assert.ok(error instanceof AppConnectError)
      assert.equal(error.code, APP_CONNECT_ERROR_CODES.CLIENT_APPROVAL_REQUIRED)
      assert.equal(
        error.message,
        'Figma MCP Server must approve Nessie as a sign-in client before it can connect.',
      )
      return true
    },
  )
})

/** A pre-registered (static) OAuth app, the curated Notion/Linear shape. */
const oauthEntry = (): McpCatalogEntryRow =>
  catalogEntry({
    authMethod: 'oauth2',
    authConfig: {
      method: 'oauth2',
      authorizationUrl: 'https://93.184.216.34/authorize',
      tokenUrl: 'https://93.184.216.34/token',
      clientId: 'nessie-test-client',
      scopes: [],
    },
  })

test('an OAuth server hands back an authorization URL instead of connecting', async () => {
  const { ctx } = makeAppConnectStub({ entry: oauthEntry() })
  const outcome = await runConnectHandshake(
    ctx,
    { label: 'Acme', authMethod: 'oauth2' },
    instanceRow(),
  )
  assert.equal(outcome.status, 'authorize')
  if (outcome.status !== 'authorize') return
  assert.equal(outcome.connectionId, 'instance-1')
  assert.ok(outcome.authorizationUrl.startsWith('https://93.184.216.34/authorize?'))
  // The state token is minted by `startOAuth`; connect neither invents nor
  // rewrites one.
  assert.ok(new URL(outcome.authorizationUrl).searchParams.get('state'))
})

test('coming back from the provider leaves a connected account, not a spinner', async () => {
  // The half of Connect that only exists once the person returns. Connect hands
  // out an authorization URL and stops; if nothing probes when the callback
  // lands, the instance sits at `pending_setup` — `connecting` in the store's
  // vocabulary — so a successful sign-in reads as a failure to the one person
  // who knows it worked, and Capabilities stays empty.
  const { ctx, connection } = makeAppConnectStub({
    entry: oauthEntry(),
    probe: { descriptors: [{ name: 'search', description: '' } as McpToolDescriptor] },
  })
  const outcome = await runConnectHandshake(
    ctx,
    { label: 'Acme', authMethod: 'oauth2' },
    instanceRow(),
  )
  assert.equal(outcome.status, 'authorize')
  if (outcome.status !== 'authorize') return

  await completeOAuth({
    prisma: ctx.prisma,
    store: ctx.oauth.stateStore,
    secretStore: { put: async () => 'secret_connect_test' },
    tokenExchange: async () => ({ accessToken: 'ya29.fake', tokenType: 'Bearer' }),
    state: new URL(outcome.authorizationUrl).searchParams.get('state') ?? '',
    code: 'auth-code-123',
    callbackUrl: ctx.oauth.callbackUrl,
    managerFactory: ctx.managerFactory,
  })

  const stored = connection()
  assert.equal(stored?.credentialRef, 'secret_connect_test')
  assert.equal(deriveConnectionStatus(stored?.lifecycleState ?? 'pending_setup'), 'connected')
})

// ─── Reaching versus creating a connection ──────────────────────────────────

test('connecting adopts the account already installed at that scope', async () => {
  const existing = instanceRow({ id: 'instance-shared', scopeType: 'organization', scopeId: ORG })
  const { ctx, created } = makeAppConnectStub({ instanceAtScope: existing, instance: existing })
  const resolved = await resolveConnection(ctx, 'entry-1', 'organization', ORG)
  assert.equal(resolved.id, 'instance-shared')
  // Adopting, not colliding: a second connect attempt creates nothing.
  assert.equal(created.length, 0)
})

test('a member cannot install a new organisation-wide connection', async () => {
  const { ctx, created } = makeAppConnectStub({ instanceAtScope: null })
  await assert.rejects(
    resolveConnection(ctx, 'entry-1', 'organization', ORG),
    (error: unknown) =>
      error instanceof AppConnectError
      && error.code === APP_CONNECT_ERROR_CODES.CONNECT_FORBIDDEN,
  )
  assert.equal(created.length, 0)
})

test('a member cannot install a project connection by naming a stale project id', async () => {
  const { ctx, created } = makeAppConnectStub({ instanceAtScope: null })
  await assert.rejects(
    resolveConnection(ctx, 'entry-1', 'project', PROJECT),
    (error: unknown) =>
      error instanceof AppConnectError
      && error.code === APP_CONNECT_ERROR_CODES.CONNECT_FORBIDDEN,
  )
  assert.equal(created.length, 0)
})

test('a member installs their own connection at their own user scope', async () => {
  const { ctx, created } = makeAppConnectStub({ instanceAtScope: null })
  const resolved = await resolveConnection(ctx, 'entry-1', 'user', MEMBER)
  assert.equal(resolved.id, 'instance-new')
  assert.equal(created.length, 1)
  assert.equal(created[0]?.scopeId, MEMBER)
})

test('a failed registry probe discovers OAuth through its catalog endpoint', async () => {
  const endpoint = 'https://mcp.linear.app/mcp'
  const authorizationServer = 'https://auth.linear.test'
  const resolveHost = async () => ['93.184.216.34']
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input)
    if ((init?.method ?? 'GET') === 'POST' && url === endpoint) {
      return new Response('', { status: 401, headers: { 'www-authenticate': 'Bearer' } })
    }
    if (url === 'https://mcp.linear.app/.well-known/oauth-protected-resource/mcp') {
      return new Response(JSON.stringify({ authorization_servers: [authorizationServer] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    if (url === 'https://auth.linear.test/.well-known/oauth-authorization-server') {
      return new Response(JSON.stringify({
        authorization_endpoint: `${authorizationServer}/authorize`,
        token_endpoint: `${authorizationServer}/token`,
        registration_endpoint: `${authorizationServer}/register`,
        code_challenge_methods_supported: ['S256'],
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    if (init?.method === 'POST' && url === `${authorizationServer}/register`) {
      return new Response(JSON.stringify({ client_id: 'linear-test-client' }), {
        status: 201,
        headers: { 'content-type': 'application/json' },
      })
    }
    return new Response('not found', { status: 404 })
  }) as typeof fetch
  const { ctx, catalogWrites, discoveryUrls } = makeAppConnectStub({
    entry: catalogEntry({ defaultTransportConfig: { transport: 'http', url: endpoint } }),
    appSource: 'mcp_registry',
    discoverAuthMethod: 'oauth2',
    oauthDiscovery: { fetchImpl, resolveHost },
    probe: { failWith: 'HTTP 401' },
    role: 'owner',
  })
  ctx.oauth.resolveHost = resolveHost
  const outcome = await runConnectHandshake(ctx, {
    id: 'entry-1',
    label: 'Linear',
    authMethod: 'none',
    defaultTransportConfig: { transport: 'http', url: endpoint },
  }, instanceRow())
  assert.equal(outcome.status, 'authorize')
  assert.deepEqual(discoveryUrls, [endpoint])
  assert.deepEqual(catalogWrites, [{ authConfig: { method: 'oauth2' }, authMethod: 'oauth2' }])
})

test('a server that wants a bearer token persists that before opening the key panel', async () => {
  const { ctx, catalogWrites } = makeAppConnectStub({
    appSource: 'mcp_registry',
    discoverAuthMethod: 'bearer',
    probe: { failWith: 'connect ECONNREFUSED https://acme.example/mcp' },
    role: 'owner',
  })
  assert.deepEqual(
    await runConnectHandshake(
      ctx,
      { id: 'entry-1', label: 'Acme', authMethod: 'none' },
      instanceRow({ transportConfig: { transport: 'http', url: 'https://acme.example/mcp' } }),
    ),
    { status: 'needs_secret', connectionId: 'instance-1' },
  )
  // The next Connect loads this catalogue row again. It must therefore know to
  // inject the saved token into the probe, instead of retrying anonymously.
  assert.deepEqual(catalogWrites, [{ authConfig: { method: 'bearer' }, authMethod: 'bearer' }])
})

test('a human-authored row is never re-derived, and a dead listing still reads as one', async () => {
  // `appSource` defaults to 'nessie' here: a declared `none` is a statement, so
  // the probe failure stands rather than being second-guessed.
  const { ctx } = makeAppConnectStub({
    discoverAuthMethod: 'oauth2',
    probe: { failWith: 'connect ECONNREFUSED https://acme.example/mcp' },
    role: 'owner',
  })
  await assert.rejects(
    runConnectHandshake(ctx, { id: 'entry-1', label: 'Acme', authMethod: 'none' }, instanceRow()),
    (error: unknown) => {
      assert.ok(error instanceof AppConnectError)
      assert.equal(error.code, APP_CONNECT_ERROR_CODES.SERVER_UNREACHABLE)
      return true
    },
  )
})
