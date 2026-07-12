import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import type { PrismaClient } from '@prisma/client'
import { buildAuthorizedTransport } from '@nessie/mcp-manage'
import type { AuthorizedActionContext } from '@nessie/schemas'

import {
  DeepWaterMcpUrlUnsetError,
  ensureDeepWaterTeamInstance,
  removeDeepWaterTeamInstance,
} from '../src/services/deepwater-activation.js'

/**
 * Team-scoped DeepWater activation: enabling for a team creates a team-scoped
 * tool-projecting instance with a usable HTTP transport (resolved from
 * DEEP_WATER_MCP_URL) whose `research_*` tools land in `ToolRegistryEntry` as
 * active, explicit-grant rows; disabling removes it. Uses an in-memory Prisma
 * fake — no MCP traffic (DeepWater tools come from the plugin manifest, not a
 * probe). The endpoint is an IP literal so the SSRF guard passes without DNS.
 */

const DEEP_WATER_URL = 'https://8.8.8.8/mcp'
process.env.DEEP_WATER_MCP_URL = DEEP_WATER_URL

type CatalogEntry = {
  id: string
  name: string
  visibility: string
  status: string
  authMethod: string
  authConfig: unknown
  defaultTransportConfig: unknown
  locked: boolean
  label: string
  ownerUserId: string | null
  organizationId: string | null
}
type Instance = {
  id: string
  organizationId: string
  catalogEntryId: string
  scopeType: string
  scopeId: string
  lifecycleState: string
  transportConfig: unknown
  discoveredTools: unknown
}
type RegistryEntry = {
  id: string
  organizationId: string
  scopeKey: string
  toolId: string
  label: string
  description: string
  inputSchema: unknown
  outputSchema: unknown
  status: string
  metadata: unknown
  mcpInstanceId: string
}

const DEEP_WATER_CATALOG_ID = randomUUID()

const makeFake = (seed: {
  organizationId: string
  teamId: string
  withCatalog?: boolean
  seedInstances?: Instance[]
  seedRegistry?: RegistryEntry[]
}) => {
  const catalogEntries: CatalogEntry[] = seed.withCatalog === false
    ? []
    : [
        {
          id: DEEP_WATER_CATALOG_ID,
          name: 'deep-water',
          visibility: 'public',
          status: 'published',
          authMethod: 'oauth2',
          authConfig: { method: 'oauth2' },
          // Manifest default carries `urlEnv` (no url) — parses to a skip in the
          // SSRF guard; the instance transportConfig supplies the real url.
          defaultTransportConfig: { urlEnv: 'DEEP_WATER_MCP_URL' },
          locked: false,
          label: 'Deep Water',
          ownerUserId: null,
          organizationId: null,
        },
      ]
  const instances: Instance[] = seed.seedInstances ? [...seed.seedInstances] : []
  const registry: RegistryEntry[] = seed.seedRegistry ? [...seed.seedRegistry] : []

  const self = {
    instances,
    registry,
    $transaction: async (arg: unknown) =>
      typeof arg === 'function'
        ? (arg as (tx: unknown) => Promise<unknown>)(self)
        : Promise.all(arg as Promise<unknown>[]),
    mcpCatalogEntry: {
      findFirst: async (args: { where: { id?: string; name?: string } }) => {
        if (args.where.id !== undefined) {
          return catalogEntries.find((e) => e.id === args.where.id) ?? null
        }
        return catalogEntries.find((e) => e.name === args.where.name) ?? null
      },
      findMany: async () => [],
    },
    team: {
      findFirst: async (args: { where: { id: string } }) =>
        args.where.id === seed.teamId ? { id: seed.teamId } : null,
    },
    mcpServerInstance: {
      findFirst: async (args: {
        where: {
          organizationId: string
          catalogEntryId?: string
          scopeType: string
          scopeId: string
          catalogEntry?: { name: string }
        }
      }) =>
        instances.find((i) => {
          if (i.organizationId !== args.where.organizationId) return false
          if (i.scopeType !== args.where.scopeType) return false
          if (i.scopeId !== args.where.scopeId) return false
          if (args.where.catalogEntryId !== undefined) {
            return i.catalogEntryId === args.where.catalogEntryId
          }
          if (args.where.catalogEntry?.name !== undefined) {
            const entry = catalogEntries.find((e) => e.id === i.catalogEntryId)
            return entry?.name === args.where.catalogEntry.name
          }
          return true
        }) ?? null,
      findUniqueOrThrow: async (args: { where: { id: string } }) => {
        const row = instances.find((i) => i.id === args.where.id)
        if (!row) throw new Error('instance not found')
        return row
      },
      create: async (args: { data: Record<string, unknown> }) => {
        const row: Instance = {
          id: randomUUID(),
          organizationId: args.data.organizationId as string,
          catalogEntryId: args.data.catalogEntryId as string,
          scopeType: args.data.scopeType as string,
          scopeId: args.data.scopeId as string,
          lifecycleState: (args.data.lifecycleState as string) ?? 'pending_setup',
          transportConfig: args.data.transportConfig ?? {},
          discoveredTools: args.data.discoveredTools ?? [],
        }
        instances.push(row)
        return row
      },
      update: async (args: { where: { id: string }; data: Record<string, unknown> }) => {
        const row = instances.find((i) => i.id === args.where.id)
        if (!row) return null
        if (typeof args.data.lifecycleState === 'string') {
          row.lifecycleState = args.data.lifecycleState
        }
        if (args.data.transportConfig !== undefined) row.transportConfig = args.data.transportConfig
        if (args.data.discoveredTools !== undefined) row.discoveredTools = args.data.discoveredTools
        return row
      },
      delete: async (args: { where: { id: string } }) => {
        const idx = instances.findIndex((i) => i.id === args.where.id)
        if (idx >= 0) instances.splice(idx, 1)
        return { id: args.where.id }
      },
    },
    toolRegistryEntry: {
      findMany: async (args: { where: { mcpInstanceId: string } }) =>
        registry.filter((r) => r.mcpInstanceId === args.where.mcpInstanceId),
      upsert: async (args: {
        where: { organizationId_scopeKey_toolId: { toolId: string } }
        create: RegistryEntry
        update: { status?: string }
      }) => {
        const toolId = args.where.organizationId_scopeKey_toolId.toolId
        const existing = registry.find((r) => r.toolId === toolId)
        if (existing) {
          if (args.update.status) existing.status = args.update.status
          return existing
        }
        const row: RegistryEntry = { ...args.create, id: randomUUID() }
        registry.push(row)
        return row
      },
      updateMany: async (args: {
        where: { mcpInstanceId: string }
        data: { status?: string; metadata?: unknown }
      }) => {
        let count = 0
        for (const r of registry) {
          if (r.mcpInstanceId === args.where.mcpInstanceId) {
            if (args.data.status) r.status = args.data.status
            if (args.data.metadata !== undefined) r.metadata = args.data.metadata
            count += 1
          }
        }
        return { count }
      },
      deleteMany: async (args: { where: { mcpInstanceId: string } }) => {
        for (let i = registry.length - 1; i >= 0; i -= 1) {
          if (registry[i]!.mcpInstanceId === args.where.mcpInstanceId) registry.splice(i, 1)
        }
        return { count: 0 }
      },
    },
  }
  return self
}

const asPrisma = (fake: ReturnType<typeof makeFake>): PrismaClient =>
  fake as unknown as PrismaClient

const ownerContext = (organizationId: string): AuthorizedActionContext =>
  ({
    tenant: { organizationId },
    actor: { actorId: randomUUID(), actorType: 'user', roles: ['owner'] },
    actionContext: {},
  }) as unknown as AuthorizedActionContext

test('enabling DeepWater creates a team-scoped instance with a usable transport and explicit-grant tools', async () => {
  const seed = { organizationId: randomUUID(), teamId: randomUUID() }
  const fake = makeFake(seed)

  const instance = await ensureDeepWaterTeamInstance(asPrisma(fake), ownerContext(seed.organizationId), seed)

  assert.ok(instance)
  assert.equal(fake.instances.length, 1)
  assert.equal(fake.instances[0]?.scopeType, 'team')
  assert.equal(fake.instances[0]?.scopeId, seed.teamId)
  assert.equal(fake.instances[0]?.lifecycleState, 'active')

  // F2: the instance carries a resolvable HTTP transport, and a full transport
  // builds from catalog default + instance config without dropping tools.
  assert.deepEqual(fake.instances[0]?.transportConfig, { transport: 'http', url: DEEP_WATER_URL })
  const transport = buildAuthorizedTransport({
    catalogDefaultTransportConfig: { urlEnv: 'DEEP_WATER_MCP_URL' },
    instanceTransportConfig: fake.instances[0]?.transportConfig,
    authConfig: { method: 'oauth2' },
    secret: null,
  })
  assert.equal(transport.transport, 'http')
  assert.equal((transport as { url: string }).url, DEEP_WATER_URL)

  // The manifest's six research tools are projected, all active, and flagged as
  // requiring an explicit per-agent grant.
  const toolNames = fake.registry.map((r) => r.toolId.split(':').pop())
  assert.ok(toolNames.includes('research_create'))
  assert.ok(toolNames.includes('research_get'))
  assert.equal(fake.registry.length, 6)
  assert.ok(fake.registry.every((r) => r.status === 'active'))
  assert.ok(fake.registry.every((r) =>
    (r.metadata as { requiresExplicitGrant?: boolean })?.requiresExplicitGrant === true))
  assert.ok(fake.registry.every((r) => r.mcpInstanceId === fake.instances[0]?.id))
})

test('enabling DeepWater twice is idempotent (no duplicate instance)', async () => {
  const seed = { organizationId: randomUUID(), teamId: randomUUID() }
  const fake = makeFake(seed)

  await ensureDeepWaterTeamInstance(asPrisma(fake), ownerContext(seed.organizationId), seed)
  await ensureDeepWaterTeamInstance(asPrisma(fake), ownerContext(seed.organizationId), seed)

  assert.equal(fake.instances.length, 1)
  assert.equal(fake.registry.length, 6)
})

test('re-enable does not clobber a manually-probed instance schema', async () => {
  const seed = { organizationId: randomUUID(), teamId: randomUUID() }
  const instanceId = randomUUID()
  const probedSchema = { type: 'object', properties: { q: { type: 'string' } } }
  const fake = makeFake({
    ...seed,
    seedInstances: [
      {
        id: instanceId,
        organizationId: seed.organizationId,
        catalogEntryId: DEEP_WATER_CATALOG_ID,
        scopeType: 'team',
        scopeId: seed.teamId,
        lifecycleState: 'active',
        transportConfig: { transport: 'http', url: 'https://self-hosted.example.org/mcp' },
        discoveredTools: [{ name: 'research_create', inputSchema: probedSchema }],
      },
    ],
    seedRegistry: [
      {
        id: randomUUID(),
        organizationId: seed.organizationId,
        scopeKey: `mcp:${seed.organizationId}:team:${seed.teamId}`,
        toolId: `mcp:${instanceId}:research_create`,
        label: 'Create research',
        description: 'probed',
        inputSchema: probedSchema,
        outputSchema: null,
        status: 'active',
        metadata: {},
        mcpInstanceId: instanceId,
      },
    ],
  })

  await ensureDeepWaterTeamInstance(asPrisma(fake), ownerContext(seed.organizationId), seed)

  // No manifest stubs written over the probed schema; the custom endpoint stays.
  assert.equal(fake.registry.length, 1)
  assert.deepEqual(fake.registry[0]?.inputSchema, probedSchema)
  assert.deepEqual(fake.instances[0]?.transportConfig, {
    transport: 'http',
    url: 'https://self-hosted.example.org/mcp',
  })
  // But the row is still flagged explicit-grant + active.
  assert.equal(fake.registry[0]?.status, 'active')
  assert.equal(
    (fake.registry[0]?.metadata as { requiresExplicitGrant?: boolean })?.requiresExplicitGrant,
    true,
  )
})

test('disabling DeepWater removes the instance and its projected tools', async () => {
  const seed = { organizationId: randomUUID(), teamId: randomUUID() }
  const fake = makeFake(seed)

  await ensureDeepWaterTeamInstance(asPrisma(fake), ownerContext(seed.organizationId), seed)
  const result = await removeDeepWaterTeamInstance(asPrisma(fake), seed)

  assert.ok(result.instanceId)
  assert.equal(fake.instances.length, 0)
  assert.equal(fake.registry.length, 0)
})

test('activation is a no-op when the DeepWater catalog entry is absent', async () => {
  const seed = { organizationId: randomUUID(), teamId: randomUUID(), withCatalog: false }
  const fake = makeFake(seed)

  const instance = await ensureDeepWaterTeamInstance(asPrisma(fake), ownerContext(seed.organizationId), seed)

  assert.equal(instance, null)
  assert.equal(fake.instances.length, 0)
  assert.equal(fake.registry.length, 0)
})

test('enable fails loudly when DEEP_WATER_MCP_URL is unset', async () => {
  const seed = { organizationId: randomUUID(), teamId: randomUUID() }
  const fake = makeFake(seed)
  const previous = process.env.DEEP_WATER_MCP_URL
  delete process.env.DEEP_WATER_MCP_URL
  try {
    await assert.rejects(
      ensureDeepWaterTeamInstance(asPrisma(fake), ownerContext(seed.organizationId), seed),
      (error: unknown) =>
        error instanceof DeepWaterMcpUrlUnsetError && error.code === 'DEEP_WATER_MCP_URL_UNSET',
    )
    assert.equal(fake.instances.length, 0)
  } finally {
    process.env.DEEP_WATER_MCP_URL = previous
  }
})
