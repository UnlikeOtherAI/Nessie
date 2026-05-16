import assert from 'node:assert/strict'
import test from 'node:test'

import type {
  McpClientManager,
  McpConnectionId,
  McpToolDescriptor,
} from '@nessie/mcp-client'

import type { PrismaClient } from '@prisma/client'

import {
  MCP_INSTANCE_ERROR_CODES,
  McpInstanceError,
  descriptorDiffersFromEntry,
  healthcheckInstance,
  probeConnection,
  refreshInstance,
  resolveInstanceTransport,
  testInstance,
  type McpInstanceRow,
  type ManagerFactory,
} from '../src/services/mcp-instances.js'

const baseInstance: McpInstanceRow = {
  id: 'instance-1',
  catalogEntryId: 'catalog-1',
  organizationId: 'org-1',
  scopeType: 'organization',
  scopeId: 'org-1',
  credentialRef: null,
  transportConfig: {},
  discoveredTools: [],
  lifecycleState: 'pending_setup',
  healthLastCheckedAt: null,
  healthFailureCount: 0,
  installedBy: 'actor-1',
  createdAt: new Date(),
  updatedAt: new Date(),
}

test('resolveInstanceTransport prefers instance overrides over catalog defaults', () => {
  const resolved = resolveInstanceTransport(
    {
      ...baseInstance,
      transportConfig: { transport: 'http', url: 'https://override.example/api' },
    },
    {
      defaultTransportConfig: {
        transport: 'http',
        url: 'https://default.example/api',
        headers: { 'X-From': 'catalog' },
      },
    },
  )
  assert.equal(resolved.transport, 'http')
  if (resolved.transport === 'http') {
    assert.equal(resolved.url, 'https://override.example/api')
    assert.deepEqual(resolved.headers, { 'X-From': 'catalog' })
  }
})

test('resolveInstanceTransport falls back to catalog defaults when instance is empty', () => {
  const resolved = resolveInstanceTransport(
    { ...baseInstance, transportConfig: {} },
    {
      defaultTransportConfig: {
        transport: 'stdio',
        command: 'mcp-server',
        args: ['--verbose'],
      },
    },
  )
  assert.equal(resolved.transport, 'stdio')
  if (resolved.transport === 'stdio') {
    assert.equal(resolved.command, 'mcp-server')
    assert.deepEqual(resolved.args, ['--verbose'])
  }
})

test('resolveInstanceTransport throws typed error on invalid shape', () => {
  let thrown: unknown
  try {
    resolveInstanceTransport(
      { ...baseInstance, transportConfig: { transport: 'http' } },
      { defaultTransportConfig: {} },
    )
  } catch (error) {
    thrown = error
  }
  assert.ok(thrown instanceof McpInstanceError)
  assert.equal(
    (thrown as McpInstanceError).code,
    MCP_INSTANCE_ERROR_CODES.TRANSPORT_CONFIG_INVALID,
  )
})

// ─── probeConnection (regression for task #22) ──────────────────────────────
//
// The probe must never report `ok: true` unless the connection opened AND
// `tools/list` returned a well-formed descriptor array. Anything else
// (transport throw, auth throw, non-array response) is a probe failure and
// `testInstance` must NOT advance the instance to `lifecycleState=active`.

type FakeManagerSpec = {
  open?: () => Promise<McpConnectionId> | McpConnectionId
  listTools?: () => Promise<unknown> | unknown
  close?: () => Promise<void> | void
  closeAll?: () => Promise<void> | void
}

const makeFakeManagerFactory = (
  spec: FakeManagerSpec,
): { factory: ManagerFactory; calls: { closed: number; closedAll: number } } => {
  const calls = { closed: 0, closedAll: 0 }
  const factory: ManagerFactory = () =>
    ({
      open: async () => {
        if (spec.open) return (await spec.open()) as McpConnectionId
        return 'fake-conn-id' as McpConnectionId
      },
      listTools: async () => {
        if (spec.listTools) return (await spec.listTools()) as McpToolDescriptor[]
        return []
      },
      close: async () => {
        calls.closed += 1
        if (spec.close) await spec.close()
      },
      closeAll: async () => {
        calls.closedAll += 1
        if (spec.closeAll) await spec.closeAll()
      },
    }) as unknown as McpClientManager
  return { factory, calls }
}

test('probeConnection returns ok=true with descriptors on a clean handshake', async () => {
  const descriptors: McpToolDescriptor[] = [
    { name: 'tool_a', inputSchema: {} },
    { name: 'tool_b', inputSchema: {}, description: 'second' },
  ]
  const { factory, calls } = makeFakeManagerFactory({
    listTools: () => descriptors,
  })
  const result = await probeConnection(
    { transport: 'http', url: 'https://example.invalid/mcp' },
    factory,
  )
  assert.equal(result.ok, true)
  assert.equal(result.toolCount, 2)
  assert.deepEqual(result.descriptors, descriptors)
  assert.equal(typeof result.latencyMs, 'number')
  assert.ok(result.latencyMs >= 0)
  assert.equal(calls.closed, 1)
  assert.equal(calls.closedAll, 1)
})

test('probeConnection treats an empty tools array as a successful handshake', async () => {
  const { factory } = makeFakeManagerFactory({ listTools: () => [] })
  const result = await probeConnection(
    { transport: 'http', url: 'https://example.invalid/mcp' },
    factory,
  )
  assert.equal(result.ok, true)
  assert.equal(result.toolCount, 0)
  assert.deepEqual(result.descriptors, [])
})

test('probeConnection returns ok=false when open() throws (transport failure)', async () => {
  const { factory, calls } = makeFakeManagerFactory({
    open: () => Promise.reject(new Error('ECONNREFUSED')),
  })
  const result = await probeConnection(
    { transport: 'http', url: 'https://example.invalid/mcp' },
    factory,
  )
  assert.equal(result.ok, false)
  assert.match(result.error ?? '', /ECONNREFUSED/)
  assert.equal(result.toolCount, undefined)
  assert.equal(result.descriptors, undefined)
  // open() threw, so close() per-connection was never called; closeAll still ran.
  assert.equal(calls.closed, 0)
  assert.equal(calls.closedAll, 1)
})

test('probeConnection returns ok=false when listTools throws (auth failure)', async () => {
  const { factory } = makeFakeManagerFactory({
    listTools: () => Promise.reject(new Error('401 Unauthorized')),
  })
  const result = await probeConnection(
    { transport: 'http', url: 'https://example.invalid/mcp' },
    factory,
  )
  assert.equal(result.ok, false)
  assert.match(result.error ?? '', /401 Unauthorized/)
})

test('probeConnection returns ok=false when listTools returns a non-array (malformed handshake)', async () => {
  const { factory } = makeFakeManagerFactory({
    listTools: () => ({ tools: 'not-an-array' }) as unknown,
  })
  const result = await probeConnection(
    { transport: 'http', url: 'https://example.invalid/mcp' },
    factory,
  )
  assert.equal(result.ok, false)
  assert.match(result.error ?? '', /not an array/)
})

// ─── testInstance lifecycle behaviour (regression for task #22) ─────────────
//
// These cases use a hand-rolled prisma stub so we can assert that:
//   - a failing probe NEVER advances `lifecycleState` to `active`
//   - the failure path increments `healthFailureCount` and stamps
//     `healthLastCheckedAt`
//   - the success path runs the registry projection transaction

type RecordedUpdate = { where: { id: string }; data: Record<string, unknown> }

type StubRegistryEntry = {
  id: string
  toolId: string
  label: string
  description: string
  inputSchema: unknown
  outputSchema: unknown
}

type RecordedUpsert = {
  where: { scopeKey_toolId: { scopeKey: string; toolId: string } }
  create: Record<string, unknown>
  update: Record<string, unknown>
}

type RecordedUpdateMany = {
  where: Record<string, unknown>
  data: Record<string, unknown>
}

const makeStubPrisma = (
  instance: McpInstanceRow,
  catalogEntry: { authMethod: string; authConfig: unknown; defaultTransportConfig: unknown },
  options: { existingEntries?: StubRegistryEntry[] } = {},
): {
  prisma: PrismaClient
  updates: RecordedUpdate[]
  upserts: RecordedUpsert[]
  updateManys: RecordedUpdateMany[]
  transactionRan: { value: boolean }
} => {
  const updates: RecordedUpdate[] = []
  const upserts: RecordedUpsert[] = []
  const updateManys: RecordedUpdateMany[] = []
  const transactionRan = { value: false }
  const existingEntries = options.existingEntries ?? []
  const tx = {
    mcpServerInstance: {
      update: async (args: RecordedUpdate): Promise<McpInstanceRow> => {
        updates.push(args)
        return { ...instance, ...(args.data as Partial<McpInstanceRow>) }
      },
    },
    toolRegistryEntry: {
      findMany: async (): Promise<StubRegistryEntry[]> => existingEntries,
      upsert: async (args: RecordedUpsert) => {
        upserts.push(args)
        return {}
      },
      updateMany: async (args: RecordedUpdateMany) => {
        updateManys.push(args)
        return { count: 0 }
      },
    },
  }
  const prisma = {
    mcpServerInstance: {
      findFirst: async () => instance,
      update: async (args: RecordedUpdate): Promise<McpInstanceRow> => {
        updates.push(args)
        return { ...instance, ...(args.data as Partial<McpInstanceRow>) }
      },
    },
    mcpCatalogEntry: {
      findFirst: async () => catalogEntry,
    },
    $transaction: async <T>(fn: (txArg: typeof tx) => Promise<T>): Promise<T> => {
      transactionRan.value = true
      return fn(tx)
    },
  }
  return {
    prisma: prisma as unknown as PrismaClient,
    updates,
    upserts,
    updateManys,
    transactionRan,
  }
}

const catalogEntryStub = {
  authMethod: 'none',
  authConfig: { method: 'none' },
  defaultTransportConfig: { transport: 'http', url: 'https://example.invalid/mcp' },
}

test('testInstance keeps lifecycleState off "active" when probe fails', async () => {
  const { prisma, updates, transactionRan } = makeStubPrisma(baseInstance, catalogEntryStub)
  const { factory } = makeFakeManagerFactory({
    listTools: () => Promise.reject(new Error('401 invalid token')),
  })

  let thrown: unknown
  try {
    await testInstance(prisma, 'org-1', baseInstance.id, { managerFactory: factory })
  } catch (error) {
    thrown = error
  }

  assert.ok(thrown instanceof McpInstanceError)
  assert.equal((thrown as McpInstanceError).code, MCP_INSTANCE_ERROR_CODES.PROBE_FAILED)
  assert.match((thrown as McpInstanceError).message, /401 invalid token/)

  // Exactly one update — the failure update. No registry transaction.
  assert.equal(updates.length, 1)
  assert.equal(transactionRan.value, false)
  const failureUpdate = updates[0]?.data
  assert.equal((failureUpdate as { lifecycleState?: string }).lifecycleState, 'error')
  assert.notEqual((failureUpdate as { lifecycleState?: string }).lifecycleState, 'active')
  assert.deepEqual(
    (failureUpdate as { healthFailureCount?: unknown }).healthFailureCount,
    { increment: 1 },
  )
  assert.ok(
    (failureUpdate as { healthLastCheckedAt?: unknown }).healthLastCheckedAt instanceof Date,
  )
})

test('testInstance transitions to active and projects tools on a successful probe', async () => {
  const { prisma, updates, transactionRan } = makeStubPrisma(baseInstance, catalogEntryStub)
  const descriptors: McpToolDescriptor[] = [{ name: 'echo', inputSchema: {} }]
  const { factory } = makeFakeManagerFactory({ listTools: () => descriptors })

  const result = await testInstance(prisma, 'org-1', baseInstance.id, {
    managerFactory: factory,
  })

  assert.equal(result.lifecycleState, 'active')
  assert.equal(transactionRan.value, true)
  assert.equal(updates.length, 1)
  const successUpdate = updates[0]?.data as {
    lifecycleState?: string
    healthFailureCount?: number
    healthLastCheckedAt?: unknown
  }
  assert.equal(successUpdate.lifecycleState, 'active')
  assert.equal(successUpdate.healthFailureCount, 0)
  assert.ok(successUpdate.healthLastCheckedAt instanceof Date)
})

// ─── healthcheckInstance (task #20) ─────────────────────────────────────────
//
// healthcheck reuses `probeConnection` but performs ZERO db writes — admins
// can poll it to surface live latency without moving `healthFailureCount`.

test('healthcheckInstance reports healthy=true with latencyMs on a clean probe', async () => {
  const { prisma, updates } = makeStubPrisma(baseInstance, catalogEntryStub)
  const { factory } = makeFakeManagerFactory({ listTools: () => [] })
  const result = await healthcheckInstance(prisma, 'org-1', baseInstance.id, {
    managerFactory: factory,
  })
  assert.equal(result.healthy, true)
  assert.equal(typeof result.latencyMs, 'number')
  assert.ok(result.latencyMs >= 0)
  assert.equal(result.lastError, undefined)
  // Critical: no db writes on healthcheck.
  assert.equal(updates.length, 0)
})

test('healthcheckInstance reports healthy=false with lastError on probe failure', async () => {
  const { prisma, updates } = makeStubPrisma(baseInstance, catalogEntryStub)
  const { factory } = makeFakeManagerFactory({
    listTools: () => Promise.reject(new Error('connection refused')),
  })
  const result = await healthcheckInstance(prisma, 'org-1', baseInstance.id, {
    managerFactory: factory,
  })
  assert.equal(result.healthy, false)
  assert.match(result.lastError ?? '', /connection refused/)
  assert.equal(updates.length, 0)
})

test('healthcheckInstance throws NOT_FOUND when the instance does not exist', async () => {
  const prisma = {
    mcpServerInstance: { findFirst: async () => null },
  } as unknown as Parameters<typeof healthcheckInstance>[0]
  let thrown: unknown
  try {
    await healthcheckInstance(prisma, 'org-1', 'missing')
  } catch (error) {
    thrown = error
  }
  assert.ok(thrown instanceof McpInstanceError)
  assert.equal(
    (thrown as McpInstanceError).code,
    MCP_INSTANCE_ERROR_CODES.NOT_FOUND,
  )
})

// ─── refreshInstance (task #20) ─────────────────────────────────────────────
//
// refresh ≈ testInstance but tolerates probe failures — instead of throwing
// PROBE_FAILED (which the test route maps to 502) it returns the updated
// instance row with `lifecycleState=error` so the admin UI can render
// state-change without an HTTP error round-trip.

test('refreshInstance re-projects discovered tools on a successful probe', async () => {
  const { prisma, transactionRan } = makeStubPrisma(baseInstance, catalogEntryStub)
  const descriptors: McpToolDescriptor[] = [
    { name: 'a', inputSchema: {} },
    { name: 'b', inputSchema: {} },
  ]
  const { factory } = makeFakeManagerFactory({ listTools: () => descriptors })
  const result = await refreshInstance(prisma, 'org-1', baseInstance.id, {
    managerFactory: factory,
  })
  assert.equal(result.lifecycleState, 'active')
  assert.equal(transactionRan.value, true)
})

test('refreshInstance returns the updated row (lifecycleState=error) on probe failure', async () => {
  // Use a custom prisma stub so the second findFirst() returns the post-fail
  // row with `lifecycleState='error'`, simulating what testInstance's failure
  // update would have produced.
  const failedRow: McpInstanceRow = {
    ...baseInstance,
    lifecycleState: 'error',
    healthFailureCount: 1,
    healthLastCheckedAt: new Date(),
  }
  let findFirstCalls = 0
  const prisma = {
    mcpServerInstance: {
      findFirst: async () => {
        findFirstCalls += 1
        // First call (inside testInstance) sees the original row; second call
        // (inside refreshInstance's fallback) sees the post-fail row.
        return findFirstCalls === 1 ? baseInstance : failedRow
      },
      update: async () => failedRow,
    },
    mcpCatalogEntry: {
      findFirst: async () => catalogEntryStub,
    },
    $transaction: async <T,>(fn: any) => fn({}),
  } as unknown as Parameters<typeof refreshInstance>[0]

  const { factory } = makeFakeManagerFactory({
    listTools: () => Promise.reject(new Error('502 Bad Gateway')),
  })

  const result = await refreshInstance(prisma, 'org-1', baseInstance.id, {
    managerFactory: factory,
  })
  assert.equal(result.lifecycleState, 'error')
  assert.equal(result.healthFailureCount, 1)
})

test('refreshInstance still surfaces non-probe errors (e.g. NOT_FOUND)', async () => {
  const prisma = {
    mcpServerInstance: { findFirst: async () => null },
  } as unknown as Parameters<typeof refreshInstance>[0]
  let thrown: unknown
  try {
    await refreshInstance(prisma, 'org-1', 'missing')
  } catch (error) {
    thrown = error
  }
  assert.ok(thrown instanceof McpInstanceError)
  assert.equal(
    (thrown as McpInstanceError).code,
    MCP_INSTANCE_ERROR_CODES.NOT_FOUND,
  )
})

// ─── descriptorDiffersFromEntry (task #18) ──────────────────────────────────
//
// Unit-level checks for the diff predicate that decides whether a re-probe
// has to bounce an approved registry entry back to `pending_review`.

test('descriptorDiffersFromEntry returns false for an identical descriptor', () => {
  const drifted = descriptorDiffersFromEntry(
    {
      name: 'echo',
      title: 'Echo',
      description: 'returns input',
      inputSchema: { type: 'object', properties: { msg: { type: 'string' } } },
      outputSchema: { type: 'object' },
    },
    {
      label: 'Echo',
      description: 'returns input',
      inputSchema: { type: 'object', properties: { msg: { type: 'string' } } },
      outputSchema: { type: 'object' },
    },
  )
  assert.equal(drifted, false)
})

test('descriptorDiffersFromEntry ignores key order in JSON schemas', () => {
  const drifted = descriptorDiffersFromEntry(
    {
      name: 'echo',
      inputSchema: {
        type: 'object',
        properties: { a: { type: 'string' }, b: { type: 'number' } },
      },
    },
    {
      label: 'echo',
      description: '',
      // Same shape, reversed property order.
      inputSchema: {
        properties: { b: { type: 'number' }, a: { type: 'string' } },
        type: 'object',
      },
      outputSchema: null,
    },
  )
  assert.equal(drifted, false)
})

test('descriptorDiffersFromEntry returns true when label changes', () => {
  const drifted = descriptorDiffersFromEntry(
    { name: 'echo', title: 'Echo v2', inputSchema: {} },
    { label: 'Echo', description: '', inputSchema: {}, outputSchema: null },
  )
  assert.equal(drifted, true)
})

test('descriptorDiffersFromEntry returns true when description changes', () => {
  const drifted = descriptorDiffersFromEntry(
    { name: 'echo', description: 'now with feeling', inputSchema: {} },
    { label: 'echo', description: 'returns input', inputSchema: {}, outputSchema: null },
  )
  assert.equal(drifted, true)
})

test('descriptorDiffersFromEntry returns true when inputSchema changes', () => {
  const drifted = descriptorDiffersFromEntry(
    { name: 'echo', inputSchema: { type: 'object', required: ['msg'] } },
    { label: 'echo', description: '', inputSchema: { type: 'object' }, outputSchema: null },
  )
  assert.equal(drifted, true)
})

test('descriptorDiffersFromEntry returns true when outputSchema changes', () => {
  const drifted = descriptorDiffersFromEntry(
    { name: 'echo', inputSchema: {}, outputSchema: { type: 'string' } },
    { label: 'echo', description: '', inputSchema: {}, outputSchema: null },
  )
  assert.equal(drifted, true)
})

// ─── testInstance re-probe drift → pending_review (task #18) ────────────────
//
// On re-probe the projection must:
//   - leave `status` untouched on entries that match the new descriptor
//   - flip `status` to pending_review on entries whose label / description /
//     inputSchema / outputSchema diverged from what was approved
//   - flip `status` to pending_review on entries whose upstream tool has
//     disappeared from `tools/list` (kept enabled so dispatch stays loud)

test('testInstance leaves status untouched when descriptors are identical to existing entries', async () => {
  const existing: StubRegistryEntry = {
    id: 'entry-1',
    toolId: 'mcp:instance-1:echo',
    label: 'Echo',
    description: 'returns input',
    inputSchema: { type: 'object' },
    outputSchema: null,
  }
  const { prisma, upserts, updateManys } = makeStubPrisma(baseInstance, catalogEntryStub, {
    existingEntries: [existing],
  })
  const { factory } = makeFakeManagerFactory({
    listTools: () => [
      {
        name: 'echo',
        title: 'Echo',
        description: 'returns input',
        inputSchema: { type: 'object' },
      },
    ],
  })

  await testInstance(prisma, 'org-1', baseInstance.id, { managerFactory: factory })

  assert.equal(upserts.length, 1)
  // Identical descriptor → upsert.update must NOT carry a status field.
  assert.equal('status' in upserts[0]!.update, false)
  // No tools were removed → no updateMany sweep.
  assert.equal(updateManys.length, 0)
})

test('testInstance flips status to pending_review when descriptor schema drifted', async () => {
  const existing: StubRegistryEntry = {
    id: 'entry-1',
    toolId: 'mcp:instance-1:echo',
    label: 'Echo',
    description: 'returns input',
    inputSchema: { type: 'object' },
    outputSchema: null,
  }
  const { prisma, upserts } = makeStubPrisma(baseInstance, catalogEntryStub, {
    existingEntries: [existing],
  })
  const { factory } = makeFakeManagerFactory({
    listTools: () => [
      {
        name: 'echo',
        title: 'Echo',
        description: 'returns input',
        // inputSchema gained a required field — material drift.
        inputSchema: { type: 'object', required: ['msg'] },
      },
    ],
  })

  await testInstance(prisma, 'org-1', baseInstance.id, { managerFactory: factory })

  assert.equal(upserts.length, 1)
  assert.equal(upserts[0]!.update.status, 'pending_review')
})

test('testInstance flips status when descriptor label or description drifted', async () => {
  const existing: StubRegistryEntry = {
    id: 'entry-1',
    toolId: 'mcp:instance-1:echo',
    label: 'Echo',
    description: 'old description',
    inputSchema: {},
    outputSchema: null,
  }
  const { prisma, upserts } = makeStubPrisma(baseInstance, catalogEntryStub, {
    existingEntries: [existing],
  })
  const { factory } = makeFakeManagerFactory({
    listTools: () => [
      { name: 'echo', title: 'Echo', description: 'new description', inputSchema: {} },
    ],
  })

  await testInstance(prisma, 'org-1', baseInstance.id, { managerFactory: factory })

  assert.equal(upserts.length, 1)
  assert.equal(upserts[0]!.update.status, 'pending_review')
})

test('testInstance flips removed-tool entries to pending_review via updateMany sweep', async () => {
  const surviving: StubRegistryEntry = {
    id: 'entry-keep',
    toolId: 'mcp:instance-1:echo',
    label: 'Echo',
    description: '',
    inputSchema: {},
    outputSchema: null,
  }
  const removed: StubRegistryEntry = {
    id: 'entry-removed',
    toolId: 'mcp:instance-1:ghost',
    label: 'Ghost',
    description: 'no longer exposed',
    inputSchema: {},
    outputSchema: null,
  }
  const { prisma, upserts, updateManys } = makeStubPrisma(baseInstance, catalogEntryStub, {
    existingEntries: [surviving, removed],
  })
  const { factory } = makeFakeManagerFactory({
    // Only `echo` is reported now — `ghost` has vanished from the server.
    listTools: () => [{ name: 'echo', title: 'Echo', inputSchema: {} }],
  })

  await testInstance(prisma, 'org-1', baseInstance.id, { managerFactory: factory })

  // One upsert for the surviving tool, identical → no status flip.
  assert.equal(upserts.length, 1)
  assert.equal('status' in upserts[0]!.update, false)
  // One updateMany sweeping the ghost entry into pending_review.
  assert.equal(updateManys.length, 1)
  assert.deepEqual(updateManys[0]!.where, { id: { in: ['entry-removed'] } })
  assert.equal(updateManys[0]!.data.status, 'pending_review')
})

test('testInstance skips the removal sweep when every existing entry is still present', async () => {
  const existing: StubRegistryEntry = {
    id: 'entry-1',
    toolId: 'mcp:instance-1:echo',
    label: 'Echo',
    description: '',
    inputSchema: {},
    outputSchema: null,
  }
  const { prisma, updateManys } = makeStubPrisma(baseInstance, catalogEntryStub, {
    existingEntries: [existing],
  })
  const { factory } = makeFakeManagerFactory({
    listTools: () => [{ name: 'echo', title: 'Echo', inputSchema: {} }],
  })

  await testInstance(prisma, 'org-1', baseInstance.id, { managerFactory: factory })
  assert.equal(updateManys.length, 0)
})
