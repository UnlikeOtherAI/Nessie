import assert from 'node:assert/strict'
import test from 'node:test'

import {
  McpAuthError,
  McpProtocolError,
  McpTransportError,
  type McpClientManager,
  type McpConnectionId,
  type McpToolDescriptor,
} from '@nessie/mcp-client'
import type { PrismaClient } from '@prisma/client'

import type { AuthorizedActionContext } from '@nessie/schemas'

import {
  captureConnectionCapabilities,
  defaultCapabilityListing,
  discoverAppCapabilities,
  persistAppCapabilities,
  type AppCapabilityDiscovery,
  type McpCapabilityListing,
} from '../src/apps/app-capabilities.js'
import type { ManagerFactory, McpInstanceRow } from '../src/index.js'

/**
 * Capability discovery has three properties worth pinning, and each one has a
 * failure mode that would be invisible without a test:
 *
 *  - it never sends a listing the server did not advertise (that is how a
 *    healthy app acquires an error on its own store card),
 *  - it never calls a tool (listing must not be able to make an app act), and
 *  - `0` and `null` mean different things, so a bad minute cannot overwrite a
 *    known-good count with a confident zero.
 */

const ENDPOINT = 'https://93.184.216.34/mcp'

type FakeManagerSpec = {
  open?: () => Promise<McpConnectionId> | McpConnectionId
  listTools?: () => Promise<unknown> | unknown
  /** What the handshake advertised; absent means "advertised nothing". */
  advertised?: { tools: boolean; resources: boolean; prompts: boolean }
  resources?: readonly unknown[]
  prompts?: readonly unknown[]
}

type ManagerCalls = {
  opened: number
  closed: number
  closedAll: number
  toolsCalled: number
}

const makeFakeManagerFactory = (
  spec: FakeManagerSpec = {},
): { factory: ManagerFactory; calls: ManagerCalls } => {
  const calls: ManagerCalls = { opened: 0, closed: 0, closedAll: 0, toolsCalled: 0 }
  const factory: ManagerFactory = () =>
    ({
      open: async () => {
        calls.opened += 1
        if (spec.open) return (await spec.open()) as McpConnectionId
        return 'fake-conn-id' as McpConnectionId
      },
      listTools: async () => {
        if (spec.listTools) return (await spec.listTools()) as McpToolDescriptor[]
        return []
      },
      serverCapabilities: () => spec.advertised ?? null,
      listResources: async () => [...(spec.resources ?? [])],
      listPrompts: async () => [...(spec.prompts ?? [])],
      callTool: async () => {
        calls.toolsCalled += 1
        return { isError: false, content: [] }
      },
      close: async () => {
        calls.closed += 1
      },
      closeAll: async () => {
        calls.closedAll += 1
      },
    }) as unknown as McpClientManager
  return { factory, calls }
}

type ListingCalls = { resources: number; prompts: number }

const makeListing = (
  advertised: { resources: boolean; prompts: boolean },
  entries: { resources?: readonly unknown[] | Error; prompts?: readonly unknown[] | Error } = {},
): { listing: McpCapabilityListing; calls: ListingCalls } => {
  const calls: ListingCalls = { resources: 0, prompts: 0 }
  const answer = async (
    kind: keyof ListingCalls,
    value: readonly unknown[] | Error | undefined,
  ): Promise<readonly unknown[]> => {
    calls[kind] += 1
    if (value instanceof Error) throw value
    return value ?? []
  }
  return {
    listing: {
      advertised,
      listResources: () => answer('resources', entries.resources),
      listPrompts: () => answer('prompts', entries.prompts),
    },
    calls,
  }
}

const descriptors: McpToolDescriptor[] = [
  { name: 'tool_a', inputSchema: {} },
  { name: 'tool_b', inputSchema: {}, description: 'second' },
]

test('a clean handshake reports tools, and the advertised listings it actually ran', async () => {
  const { factory, calls } = makeFakeManagerFactory({ listTools: () => descriptors })
  const { listing, calls: listed } = makeListing(
    { resources: true, prompts: true },
    { resources: [{}, {}, {}], prompts: [{}] },
  )

  const result = await discoverAppCapabilities(
    { transport: 'http', url: ENDPOINT },
    { managerFactory: factory, capabilityListing: () => listing },
  )

  assert.equal(result.reachable, true)
  assert.equal(result.initializationSuccessful, true)
  assert.equal(result.toolCount, 2)
  assert.equal(result.resourceCount, 3)
  assert.equal(result.promptCount, 1)
  assert.deepEqual(result.descriptors, descriptors)
  assert.equal(result.error, null)
  assert.ok(result.latencyMs >= 0)
  assert.deepEqual(listed, { resources: 1, prompts: 1 })
  assert.equal(calls.closed, 1)
  assert.equal(calls.closedAll, 1)
})

test('an unadvertised listing is answered as 0 from the handshake and never sent', async () => {
  // Sending `resources/list` to a server that never advertised `resources` is
  // how a healthy app ends up with an error on its store card.
  const { factory } = makeFakeManagerFactory({ listTools: () => descriptors })
  const { listing, calls: listed } = makeListing({ resources: false, prompts: false })

  const result = await discoverAppCapabilities(
    { transport: 'http', url: ENDPOINT },
    { managerFactory: factory, capabilityListing: () => listing },
  )

  assert.equal(result.resourceCount, 0)
  assert.equal(result.promptCount, 0)
  assert.deepEqual(listed, { resources: 0, prompts: 0 })
})

test('each listing is gated independently — prompts advertised, resources not', async () => {
  const { factory } = makeFakeManagerFactory({ listTools: () => descriptors })
  const { listing, calls: listed } = makeListing(
    { resources: false, prompts: true },
    { prompts: [{}, {}] },
  )

  const result = await discoverAppCapabilities(
    { transport: 'http', url: ENDPOINT },
    { managerFactory: factory, capabilityListing: () => listing },
  )

  assert.equal(result.resourceCount, 0)
  assert.equal(result.promptCount, 2)
  assert.deepEqual(listed, { resources: 0, prompts: 1 })
})

test('an advertised listing that fails is undetermined, and does not fail the discovery', async () => {
  const { factory } = makeFakeManagerFactory({ listTools: () => descriptors })
  const { listing } = makeListing(
    { resources: true, prompts: true },
    { resources: new Error('resources/list exploded'), prompts: [{}] },
  )

  const result = await discoverAppCapabilities(
    { transport: 'http', url: ENDPOINT },
    { managerFactory: factory, capabilityListing: () => listing },
  )

  assert.equal(result.initializationSuccessful, true)
  assert.equal(result.toolCount, 2)
  assert.equal(result.resourceCount, null, 'unknown, not zero')
  assert.equal(result.promptCount, 1)
  assert.equal(result.error, null)
})

test('a listing adapter that cannot answer leaves the counts null, never guessed as 0', async () => {
  const { factory } = makeFakeManagerFactory({ listTools: () => descriptors })

  const result = await discoverAppCapabilities(
    { transport: 'http', url: ENDPOINT },
    { managerFactory: factory, capabilityListing: () => null },
  )

  assert.equal(result.toolCount, 2)
  assert.equal(result.resourceCount, null)
  assert.equal(result.promptCount, null)
})

test('the default adapter reads the handshake and lists what it advertised', async () => {
  // No adapter passed: a production caller must not be able to discover tools
  // and silently nothing else.
  const { factory } = makeFakeManagerFactory({
    listTools: () => descriptors,
    advertised: { tools: true, resources: true, prompts: false },
    resources: [{}, {}, {}, {}],
    prompts: [{}, {}],
  })

  const result = await discoverAppCapabilities(
    { transport: 'http', url: ENDPOINT },
    { managerFactory: factory },
  )

  assert.equal(result.resourceCount, 4)
  // Advertised `prompts: false`, so the count comes from the handshake and the
  // two prompts the fake would have returned are never asked for.
  assert.equal(result.promptCount, 0)
})

test('a server that advertised nothing is undetermined, not empty', async () => {
  const listing = defaultCapabilityListing(
    { serverCapabilities: () => null } as unknown as McpClientManager,
    'fake-conn-id' as McpConnectionId,
  )
  assert.equal(listing, null)
})

test('discovery is read-only: it lists, and never calls a tool', async () => {
  const { factory, calls } = makeFakeManagerFactory({ listTools: () => descriptors })
  const { listing } = makeListing({ resources: true, prompts: true })

  await discoverAppCapabilities(
    { transport: 'http', url: ENDPOINT },
    { managerFactory: factory, capabilityListing: () => listing },
  )

  assert.equal(calls.toolsCalled, 0)
})

test('a transport failure is unreachable; an auth or protocol refusal is a server that answered', async () => {
  const cases: ReadonlyArray<[Error, boolean]> = [
    [new McpTransportError('connect ECONNREFUSED'), false],
    [new McpAuthError('401 Unauthorized'), true],
    [new McpProtocolError('invalid params'), true],
  ]
  for (const [error, reachable] of cases) {
    const { factory, calls } = makeFakeManagerFactory({ open: () => Promise.reject(error) })
    const result = await discoverAppCapabilities(
      { transport: 'http', url: ENDPOINT },
      { managerFactory: factory },
    )
    assert.equal(result.reachable, reachable, error.message)
    assert.equal(result.initializationSuccessful, false, error.message)
    assert.equal(result.toolCount, null)
    assert.equal(result.error, error.message)
    // Nothing was opened, so nothing is closed — but the manager is still torn
    // down so a half-dialed transport cannot leak a socket.
    assert.equal(calls.closed, 0)
    assert.equal(calls.closedAll, 1)
  }
})

test('a private-network endpoint is refused before the connection is opened', async () => {
  const { factory, calls } = makeFakeManagerFactory()

  const result = await discoverAppCapabilities(
    { transport: 'http', url: 'http://169.254.169.254/latest/meta-data' },
    { managerFactory: factory },
  )

  assert.equal(calls.opened, 0)
  assert.equal(result.reachable, false)
  assert.equal(result.initializationSuccessful, false)
  assert.match(result.error ?? '', /Private or local network/)
})

test('a handshake that succeeds and then fails to list is initialized but has no counts', async () => {
  for (const listTools of [
    (): Promise<unknown> => Promise.reject(new Error('tools/list timed out')),
    (): unknown => ({ tools: 'not-an-array' }),
  ]) {
    const { factory, calls } = makeFakeManagerFactory({ listTools })
    const result = await discoverAppCapabilities(
      { transport: 'http', url: ENDPOINT },
      { managerFactory: factory },
    )
    assert.equal(result.reachable, true)
    assert.equal(result.initializationSuccessful, true, 'open() resolved, so initialize succeeded')
    assert.equal(result.toolCount, null)
    assert.equal(result.descriptors, null)
    assert.ok(result.error)
    assert.equal(calls.closed, 1, 'the open connection is always closed')
  }
})

// ─── persistence ────────────────────────────────────────────────────────────

type HealthUpsert = {
  where: { catalogEntryId: string }
  create: Record<string, unknown>
  update: Record<string, unknown>
}

type CatalogUpdate = { where: { id: string }; data: Record<string, unknown> }

/**
 * The two writes a discovery makes, plus the two reads a capture makes on its
 * way there (the catalogue row it resolves a transport from, and the 7-level
 * credential chain). `catalogEntry: null` is a row that has gone.
 */
const makeStubPrisma = (
  reads: { catalogEntry?: Record<string, unknown> | null } = {},
): {
  prisma: PrismaClient
  healthUpserts: HealthUpsert[]
  catalogUpdates: CatalogUpdate[]
} => {
  const healthUpserts: HealthUpsert[] = []
  const catalogUpdates: CatalogUpdate[] = []
  const prisma = {
    mcpServerHealth: {
      upsert: async (args: HealthUpsert) => {
        healthUpserts.push(args)
        return {}
      },
    },
    mcpCatalogEntry: {
      findFirst: async () => reads.catalogEntry ?? null,
      update: async (args: CatalogUpdate) => {
        catalogUpdates.push(args)
        return {}
      },
    },
    mcpServerInstance: { findUnique: async () => instanceRow() },
    mcpServerCredentialOverride: { findUnique: async () => null },
  } as unknown as PrismaClient
  return { prisma, healthUpserts, catalogUpdates }
}

const discovery = (
  overrides: Partial<AppCapabilityDiscovery> = {},
): AppCapabilityDiscovery => ({
  reachable: true,
  initializationSuccessful: true,
  latencyMs: 12,
  toolCount: 42,
  resourceCount: 3,
  promptCount: 1,
  descriptors: [],
  error: null,
  ...overrides,
})

const CHECKED_AT = new Date('2026-08-29T09:00:00.000Z')

test('a successful discovery writes the health row and caches the counts', async () => {
  const { prisma, healthUpserts, catalogUpdates } = makeStubPrisma()

  await persistAppCapabilities(prisma, 'catalog-1', discovery(), CHECKED_AT)

  assert.equal(healthUpserts.length, 1)
  assert.deepEqual(healthUpserts[0]?.where, { catalogEntryId: 'catalog-1' })
  assert.deepEqual(healthUpserts[0]?.update, {
    reachable: true,
    initializationSuccessful: true,
    latencyMs: 12,
    toolCount: 42,
    resourceCount: 3,
    promptCount: 1,
    checkedAt: CHECKED_AT,
    error: null,
  })
  assert.deepEqual(catalogUpdates, [
    {
      where: { id: 'catalog-1' },
      data: {
        toolCount: 42,
        resourceCount: 3,
        promptCount: 1,
        capabilitiesAt: CHECKED_AT,
      },
    },
  ])
})

test('a failed discovery records the failure and leaves the cached counts alone', async () => {
  const { prisma, healthUpserts, catalogUpdates } = makeStubPrisma()

  await persistAppCapabilities(
    prisma,
    'catalog-1',
    discovery({
      reachable: false,
      initializationSuccessful: false,
      toolCount: null,
      resourceCount: null,
      promptCount: null,
      descriptors: null,
      error: 'connect ECONNREFUSED',
    }),
    CHECKED_AT,
  )

  assert.equal(healthUpserts.length, 1)
  assert.equal(healthUpserts[0]?.update.reachable, false)
  assert.equal(healthUpserts[0]?.update.error, 'connect ECONNREFUSED')
  // Blanking here would empty every card each time an app had a bad minute.
  assert.deepEqual(catalogUpdates, [])
})

test('an undetermined count is omitted from the update, never written as null', async () => {
  const { prisma, catalogUpdates } = makeStubPrisma()

  await persistAppCapabilities(
    prisma,
    'catalog-1',
    discovery({ resourceCount: null, promptCount: null }),
    CHECKED_AT,
  )

  assert.deepEqual(catalogUpdates[0]?.data, { toolCount: 42, capabilitiesAt: CHECKED_AT })
})

test('an unbounded upstream error is truncated before it reaches the health row', async () => {
  const { prisma, healthUpserts } = makeStubPrisma()

  await persistAppCapabilities(
    prisma,
    'catalog-1',
    discovery({ initializationSuccessful: false, toolCount: null, error: 'x'.repeat(5_000) }),
    CHECKED_AT,
  )

  assert.equal((healthUpserts[0]?.update.error as string).length, 500)
})

// ─── The call site ──────────────────────────────────────────────────────────

/**
 * Discovery and persistence exist to be *called*: with no call site the cached
 * counts are never written (so the detail page's Resources and Prompts tiles
 * cannot render) and `mcp_server_health` stays empty (so `loadUnreachableAppIds`
 * always answers "everything is fine"). These pin that the connect flow's own
 * entry point does both.
 */

const ORG = '00000000-0000-4000-8000-00000000000a'
const MEMBER = '00000000-0000-4000-8000-0000000000c1'

const connectionContext = (prisma: PrismaClient) => ({
  prisma,
  actorContext: {
    tenant: { organizationId: ORG },
    actor: { actorId: MEMBER, actorType: 'user', roles: [] },
    actionContext: {},
  } as unknown as AuthorizedActionContext,
})

const instanceRow = (): McpInstanceRow =>
  ({
    id: 'instance-1',
    catalogEntryId: 'catalog-1',
    organizationId: ORG,
    scopeType: 'user',
    scopeId: MEMBER,
    credentialRef: null,
    transportConfig: {},
    discoveredTools: [],
    lifecycleState: 'active',
    healthLastCheckedAt: null,
    healthFailureCount: 0,
    lastError: null,
    installedBy: MEMBER,
    createdAt: new Date(),
    updatedAt: new Date(),
  }) as unknown as McpInstanceRow

const makeConnectionPrisma = () =>
  makeStubPrisma({
    catalogEntry: {
      id: 'catalog-1',
      authMethod: 'none',
      authConfig: { method: 'none' },
      defaultTransportConfig: { transport: 'http', url: ENDPOINT },
    },
  })

test('capturing a live connection writes its health row and caches its counts', async () => {
  const { prisma, healthUpserts, catalogUpdates } = makeConnectionPrisma()
  const { factory } = makeFakeManagerFactory({
    listTools: () => descriptors,
    advertised: { tools: true, resources: true, prompts: true },
    resources: [{}],
    prompts: [{}, {}],
  })

  const result = await captureConnectionCapabilities(
    { ...connectionContext(prisma), managerFactory: factory },
    instanceRow(),
  )

  assert.equal(result?.toolCount, 2)
  assert.equal(healthUpserts[0]?.update.reachable, true)
  assert.deepEqual(catalogUpdates[0]?.data.toolCount, 2)
  assert.deepEqual(catalogUpdates[0]?.data.resourceCount, 1)
  assert.deepEqual(catalogUpdates[0]?.data.promptCount, 2)
})

test('an unreachable server is recorded as unavailable, and never thrown at the caller', async () => {
  // This row is the only thing `loadUnreachableAppIds` reads, and the connect
  // that discovered it must still succeed.
  const { prisma, healthUpserts, catalogUpdates } = makeConnectionPrisma()
  const { factory } = makeFakeManagerFactory({
    open: () => Promise.reject(new McpTransportError('connect ECONNREFUSED')),
  })

  const result = await captureConnectionCapabilities(
    { ...connectionContext(prisma), managerFactory: factory },
    instanceRow(),
  )

  assert.equal(result?.reachable, false)
  assert.equal(healthUpserts[0]?.update.reachable, false)
  // Nothing was learned, so no cached count is overwritten.
  assert.deepEqual(catalogUpdates, [])
})

test('a capture that cannot even resolve the app answers null rather than failing the connect', async () => {
  const { prisma, healthUpserts } = makeStubPrisma({ catalogEntry: null })
  const { factory, calls } = makeFakeManagerFactory()

  const result = await captureConnectionCapabilities(
    { ...connectionContext(prisma), managerFactory: factory },
    instanceRow(),
  )

  assert.equal(result, null)
  assert.equal(calls.opened, 0, 'nothing is dialled without a resolved transport')
  assert.deepEqual(healthUpserts, [])
})
