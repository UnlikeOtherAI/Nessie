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
  probeConnection,
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

const makeStubPrisma = (
  instance: McpInstanceRow,
  catalogEntry: { authMethod: string; authConfig: unknown; defaultTransportConfig: unknown },
): {
  prisma: PrismaClient
  updates: RecordedUpdate[]
  transactionRan: { value: boolean }
} => {
  const updates: RecordedUpdate[] = []
  const transactionRan = { value: false }
  const tx = {
    mcpServerInstance: {
      update: async (args: RecordedUpdate): Promise<McpInstanceRow> => {
        updates.push(args)
        return { ...instance, ...(args.data as Partial<McpInstanceRow>) }
      },
    },
    toolRegistryEntry: {
      upsert: async () => ({}),
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
  return { prisma: prisma as unknown as PrismaClient, updates, transactionRan }
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
