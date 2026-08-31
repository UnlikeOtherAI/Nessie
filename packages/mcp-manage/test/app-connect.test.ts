import assert from 'node:assert/strict'
import test from 'node:test'

import type {
  McpClientManager,
  McpConnectionId,
  McpToolDescriptor,
} from '@nessie/mcp-client'
import type { AuthorizedActionContext } from '@nessie/schemas'
import type { PrismaClient } from '@prisma/client'

import {
  completeOAuth,
  createInMemoryStateStore,
  type McpCatalogEntryRow,
  type McpInstanceRow,
} from '../src/index.js'
// Addressed directly rather than through the package barrel: `apps/index.ts`
// belongs to another change in flight, so this suite must not depend on its
// export list having been updated yet.
import {
  APP_CONNECT_ERROR_CODES,
  AppConnectError,
  chooseConnectStep,
  disconnectAppConnection,
  reconnectAppConnection,
  refreshAppConnectionCapabilities,
  resolveConnection,
  runConnectHandshake,
  type AppConnectContext,
} from '../src/apps/app-connect.js'
import { deriveConnectionStatus } from '../src/apps/app-connections.js'

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

const ORG = '00000000-0000-4000-8000-00000000000a'
const MEMBER = '00000000-0000-4000-8000-0000000000c1'
const OTHER = '00000000-0000-4000-8000-0000000000c2'
const ENDPOINT = 'https://93.184.216.34/mcp'

const actor = (userId: string, roles: string[] = []): AuthorizedActionContext =>
  ({
    tenant: { organizationId: ORG },
    actor: { actorId: userId, actorType: 'user', roles },
    actionContext: {},
  }) as unknown as AuthorizedActionContext

const catalogEntry = (
  overrides: Partial<McpCatalogEntryRow> = {},
): McpCatalogEntryRow =>
  ({
    id: 'entry-1',
    organizationId: ORG,
    name: 'acme',
    label: 'Acme',
    description: '',
    protocol: 'http',
    authMethod: 'none',
    authConfig: { method: 'none' },
    defaultTransportConfig: { transport: 'http', url: ENDPOINT },
    status: 'published',
    visibility: 'private',
    locked: false,
    ownerUserId: MEMBER,
    ...overrides,
  }) as unknown as McpCatalogEntryRow

const instanceRow = (overrides: Partial<McpInstanceRow> = {}): McpInstanceRow => ({
  id: 'instance-1',
  catalogEntryId: 'entry-1',
  organizationId: ORG,
  scopeType: 'user',
  scopeId: MEMBER,
  credentialRef: null,
  transportConfig: {},
  discoveredTools: [],
  lifecycleState: 'pending_setup',
  healthLastCheckedAt: null,
  healthFailureCount: 0,
  lastError: null,
  installedBy: MEMBER,
  createdAt: new Date(),
  updatedAt: new Date(),
  ...overrides,
})

const managerFactory = (
  behaviour: { descriptors?: McpToolDescriptor[]; failWith?: string },
) => () =>
  ({
    open: async () => 'connection-1' as McpConnectionId,
    listTools: async () => {
      if (behaviour.failWith) throw new Error(behaviour.failWith)
      return behaviour.descriptors ?? []
    },
    close: async () => undefined,
    closeAll: async () => undefined,
  }) as unknown as McpClientManager

type StubOptions = {
  entry?: McpCatalogEntryRow
  /** The instance an id lookup resolves, and what a scope lookup adopts. */
  instance?: McpInstanceRow | null
  /** Present only when a scope lookup should find something to adopt. */
  instanceAtScope?: McpInstanceRow | null
  credentialRef?: string | null
  role?: 'owner' | 'admin' | 'member'
  probe?: { descriptors?: McpToolDescriptor[]; failWith?: string }
  actorId?: string
  /** `mcp_registry` marks the row's `authMethod` as the ingest default. */
  appSource?: string
  /** What a failed probe learns the server wants; never a real network call. */
  discoverAuthMethod?: 'none' | 'bearer' | 'api_key' | 'oauth2'
}

type Stub = {
  catalogWrites: Record<string, unknown>[]
  ctx: AppConnectContext
  created: Record<string, unknown>[]
  deleted: string[]
  updates: Record<string, unknown>[]
  /** The instance row as it stands now, after everything the flow wrote. */
  connection: () => McpInstanceRow | null
}

const makeStub = (options: StubOptions = {}): Stub => {
  const entry = options.entry ?? catalogEntry()
  // Mutable, because `refreshInstance` re-reads the row after a failed probe to
  // report the lifecycle state the failure just wrote. A stub that answered the
  // pre-update row would hide exactly that behaviour.
  let current: McpInstanceRow | null =
    options.instance === undefined ? instanceRow() : options.instance
  const catalogWrites: Record<string, unknown>[] = []
  const created: Record<string, unknown>[] = []
  const deleted: string[] = []
  const updates: Record<string, unknown>[] = []

  const toolRegistry = {
    findMany: async () => [],
    upsert: async () => ({}),
    updateMany: async () => ({ count: 0 }),
  }

  // `healthFailureCount: { increment: 1 }` is a Prisma atomic op, not a value;
  // drop it rather than write the operator object into the row.
  const applyUpdate = (data: Record<string, unknown>): McpInstanceRow => {
    updates.push(data)
    const plain = { ...data }
    delete plain.healthFailureCount
    current = { ...(current ?? instanceRow()), ...plain } as McpInstanceRow
    return current
  }

  const discoverEndpoint = async (url: string) => ({
    input: url,
    ok: true,
    attempts: [],
    proposal: options.discoverAuthMethod
      ? { url, transport: 'http' as const, authMethod: options.discoverAuthMethod, toolNames: [], note: null }
      : null,
  })

  const prisma = {
    mcpCatalogEntry: {
      // `isManagedIntegrationCatalogEntry` is the only reader that filters by
      // name; answering null there keeps these fixtures user-managed.
      findFirst: async (args: { where?: { name?: unknown } }) =>
        args.where?.name === undefined ? entry : null,
      // `learnAuthFromServer` reads only `appSource`, to decide whether the
      // row's `authMethod` is somebody's statement or the ingest default.
      // These fixtures are human-authored, so a failed probe stays a failed
      // probe and every case below keeps its original meaning.
      findUnique: async () => ({ appSource: options.appSource ?? 'nessie' }),
      // What `learnAuthFromServer` persists when a server proves it wants OAuth.
      update: async (args: { data: Record<string, unknown> }) => {
        catalogWrites.push(args.data)
        return entry
      },
      // The endpoint-lock sweep (`findApplicableLock`); nothing is locked here.
      findMany: async () => [],
      updateMany: async () => ({ count: 1 }),
    },
    mcpServerInstance: {
      findFirst: async (args: { where?: { id?: string } }) =>
        args.where?.id === undefined ? options.instanceAtScope ?? null : current,
      findUnique: async () => current,
      create: async (args: { data: Record<string, unknown> }) => {
        created.push(args.data)
        return { ...instanceRow(), ...args.data, id: 'instance-new' }
      },
      update: async (args: { data: Record<string, unknown> }) => applyUpdate(args.data),
      delete: async (args: { where: { id: string } }) => {
        deleted.push(args.where.id)
        return current
      },
    },
    mcpServerCredentialOverride: {
      findUnique: async () =>
        options.credentialRef ? { credentialRef: options.credentialRef } : null,
    },
    organizationMember: {
      findUnique: async () => ({ role: options.role ?? 'member', deactivatedAt: null }),
    },
    teamMember: { findMany: async () => [] },
    channelMember: { findMany: async () => [] },
    projectMember: { findMany: async () => [] },
    mcpOAuthState: { create: async () => ({}), deleteMany: async () => ({ count: 0 }) },
    $transaction: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> =>
      fn({
        mcpServerInstance: {
          update: async (args: { data: Record<string, unknown> }) => applyUpdate(args.data),
        },
        toolRegistryEntry: toolRegistry,
      }),
  } as unknown as PrismaClient

  return {
    created,
    deleted,
    updates,
    catalogWrites,
    connection: () => current,
    ctx: {
      prisma,
      actorContext: actor(options.actorId ?? MEMBER, options.role === 'owner' ? ['owner'] : []),
      oauth: {
        callbackUrl: 'https://93.184.216.34/api/mcp/oauth/callback',
        stateStore: createInMemoryStateStore(),
      },
      managerFactory: managerFactory(options.probe ?? {}),
      discoverEndpoint: discoverEndpoint as never,
    },
  }
}

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
  const { ctx } = makeStub({
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
  const { ctx, updates } = makeStub()
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
  const { ctx } = makeStub({
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
  const { ctx } = makeStub({ entry: oauthEntry() })
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
  const { ctx, connection } = makeStub({
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
  const { ctx, created } = makeStub({ instanceAtScope: existing, instance: existing })
  const resolved = await resolveConnection(ctx, 'entry-1', 'organization', ORG)
  assert.equal(resolved.id, 'instance-shared')
  // Adopting, not colliding: a second connect attempt creates nothing.
  assert.equal(created.length, 0)
})

test('a member cannot install a new organisation-wide connection', async () => {
  const { ctx, created } = makeStub({ instanceAtScope: null })
  await assert.rejects(
    resolveConnection(ctx, 'entry-1', 'organization', ORG),
    (error: unknown) =>
      error instanceof AppConnectError
      && error.code === APP_CONNECT_ERROR_CODES.CONNECT_FORBIDDEN,
  )
  assert.equal(created.length, 0)
})

test('a member installs their own connection at their own user scope', async () => {
  const { ctx, created } = makeStub({ instanceAtScope: null })
  const resolved = await resolveConnection(ctx, 'entry-1', 'user', MEMBER)
  assert.equal(resolved.id, 'instance-new')
  assert.equal(created.length, 1)
  assert.equal(created[0]?.scopeId, MEMBER)
})

test("reconnect refuses an account scoped to somebody else's identity", async () => {
  const { ctx } = makeStub({ instance: instanceRow({ scopeType: 'user', scopeId: OTHER }) })
  await assert.rejects(
    reconnectAppConnection(ctx, 'instance-1'),
    (error: unknown) =>
      error instanceof AppConnectError
      && error.code === APP_CONNECT_ERROR_CODES.CONNECT_FORBIDDEN,
  )
})

// ─── Managing one connected account ─────────────────────────────────────────

test('refreshing capabilities reports what the server offers now', async () => {
  const { ctx } = makeStub({
    probe: {
      descriptors: [
        { name: 'search', description: '' } as McpToolDescriptor,
        { name: 'create', description: '' } as McpToolDescriptor,
      ],
    },
  })
  const result = await refreshAppConnectionCapabilities(ctx, 'instance-1')
  assert.equal(result.connectionId, 'instance-1')
  assert.equal(result.status, 'connected')
  assert.equal(result.toolCount, 2)
})

test('refreshing an unreachable connection answers rather than throwing', async () => {
  const { ctx } = makeStub({ probe: { failWith: 'boom' } })
  const result = await refreshAppConnectionCapabilities(ctx, 'instance-1')
  assert.equal(result.status, 'error')
  assert.equal(result.toolCount, 0)
})

test('disconnecting needs the scope manage right, not merely reach', async () => {
  const shared = instanceRow({ scopeType: 'organization', scopeId: ORG })
  const { ctx, deleted } = makeStub({ instance: shared })
  await assert.rejects(
    disconnectAppConnection(ctx, 'instance-1'),
    (error: unknown) =>
      error instanceof AppConnectError
      && error.code === APP_CONNECT_ERROR_CODES.CONNECT_FORBIDDEN,
  )
  assert.equal(deleted.length, 0)
})

test('disconnecting reports the app and scope it removed, for the audit trail', async () => {
  const { ctx, deleted } = makeStub()
  const removed = await disconnectAppConnection(ctx, 'instance-1')
  assert.deepEqual(removed, {
    connectionId: 'instance-1',
    catalogEntryId: 'entry-1',
    scopeType: 'user',
    scopeId: MEMBER,
  })
  assert.deepEqual(deleted, ['instance-1'])
})

test('a connection that is not this organisation’s is simply not found', async () => {
  const { ctx } = makeStub({ instance: null })
  await assert.rejects(
    disconnectAppConnection(ctx, 'instance-1'),
    (error: unknown) =>
      error instanceof AppConnectError
      && error.code === APP_CONNECT_ERROR_CODES.CONNECTION_NOT_FOUND,
  )
})

test('a probe that fails on an ingested row asks the server what it wants', async () => {
  // The defect this replaces: GitLab's official MCP server answers 401 with an
  // RFC 9728 pointer to its OAuth metadata — a working server stating its terms
  // — and the store reported "we couldn't reach the server", because
  // `authMethod` on an ingested row is the ingest default rather than anybody's
  // statement. That was the answer for 4,685 of 5,548 catalogue rows.
  //
  // Asserted here: the discovery is made and its answer persisted, so the next
  // person is told what will happen before clicking and `startOAuth`'s own
  // guard passes. Completing the OAuth flow is that module's contract, not
  // this one's, so it is not restaged here.
  const { ctx, catalogWrites } = makeStub({
    appSource: 'mcp_registry',
    discoverAuthMethod: 'oauth2',
    probe: { failWith: 'connect ECONNREFUSED https://gitlab.com/api/v4/mcp' },
    role: 'owner',
  })
  await runConnectHandshake(
    ctx,
    { id: 'entry-1', label: 'GitLab', authMethod: 'none' },
    // The endpoint the failed probe used is what discovery interrogates, so a
    // fixture with an empty transport has nothing to ask.
    instanceRow({ transportConfig: { transport: 'http', url: 'https://gitlab.com/api/v4/mcp' } }),
  ).catch(() => undefined)
  assert.deepEqual(catalogWrites, [{ authConfig: { method: 'oauth2' }, authMethod: 'oauth2' }])
})

test('a server that wants a key routes to the key panel, not to an error', async () => {
  const { ctx } = makeStub({
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
})

test('a human-authored row is never re-derived, and a dead listing still reads as one', async () => {
  // `appSource` defaults to 'nessie' here: a declared `none` is a statement, so
  // the probe failure stands rather than being second-guessed.
  const { ctx } = makeStub({
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
