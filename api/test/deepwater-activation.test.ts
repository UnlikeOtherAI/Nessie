import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import type { PrismaClient } from '@prisma/client'
import { buildAuthorizedTransport } from '@nessie/mcp-manage'
import type { AuthorizedActionContext } from '@nessie/schemas'

import {
  ensureDeepWaterTeamInstance,
  NESSIE_LEDGER_APP_API_KEY_ENV,
  removeDeepWaterTeamInstance,
} from '../src/services/deepwater-activation.js'

/**
 * Team-scoped DeepWater activation: enabling for a team creates a team-scoped
 * tool-projecting instance with a usable HTTP transport (resolved from
 * LEDGER_DEEPWATER_MCP_URL) whose Ledger `research_*` tools land in
 * `ToolRegistryEntry` as active, explicit-grant rows; disabling removes it.
 * Uses an in-memory Prisma fake — no MCP traffic (tools come from the plugin
 * manifest, not a probe). The endpoint is an IP literal so the SSRF guard
 * passes without DNS.
 */

const DEEP_WATER_URL = 'https://8.8.8.8/v1/mcp/deepwater'
process.env.LEDGER_DEEPWATER_MCP_URL = DEEP_WATER_URL
process.env.LEDGER_PROXY_TOKEN = 'nessie-ledger-app-api-key'
process.env.UOA_DOMAIN = 'api.nessie.works'
process.env.UOA_CONFIG_URL = 'https://api.nessie.works/api/auth/sso/config'
process.env.UOA_CONFIG_JWT_KID = 'nessie-test'
process.env.UOA_CONFIG_JWT_PRIVATE_KEY_B64 = Buffer.from('private-key').toString('base64')
process.env.UOA_CLIENT_SECRET = 'uoa-client-secret'

type CatalogEntry = {
  id: string
  name: string
  integratedProductSlugs: string[]
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
  credentialRef: string | null
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

type CatalogWhere = {
  id?: string
  name?: string
  status?: string
  visibility?: string
  integratedProducts?: { some: { slug: string } }
}

const makeFake = (seed: {
  organizationId: string
  teamId: string
  seedCatalogEntries?: CatalogEntry[]
  seedInstances?: Instance[]
  seedRegistry?: RegistryEntry[]
}) => {
  const catalogEntries: CatalogEntry[] = seed.seedCatalogEntries ?? [
        {
          id: DEEP_WATER_CATALOG_ID,
          name: 'deep-water',
          integratedProductSlugs: ['deep-water'],
          visibility: 'public',
          status: 'published',
          authMethod: 'bearer',
          authConfig: { method: 'bearer' },
          // Manifest default carries `urlEnv` (no url) — parses to a skip in the
          // SSRF guard; the instance transportConfig supplies the real url.
          defaultTransportConfig: { urlEnv: 'LEDGER_DEEPWATER_MCP_URL' },
          locked: false,
          label: 'Deep Water',
          ownerUserId: null,
          organizationId: null,
        },
      ]
  const instances: Instance[] = seed.seedInstances ? [...seed.seedInstances] : []
  const registry: RegistryEntry[] = seed.seedRegistry ? [...seed.seedRegistry] : []
  const catalogMatches = (entry: CatalogEntry, where: CatalogWhere): boolean =>
    (where.id === undefined || entry.id === where.id)
    && (where.name === undefined || entry.name === where.name)
    && (where.status === undefined || entry.status === where.status)
    && (where.visibility === undefined || entry.visibility === where.visibility)
    && (
      where.integratedProducts === undefined
      || entry.integratedProductSlugs.includes(where.integratedProducts.some.slug)
    )

  const self = {
    catalogEntries,
    instances,
    registry,
    $transaction: async (arg: unknown) =>
      typeof arg === 'function'
        ? (arg as (tx: unknown) => Promise<unknown>)(self)
        : Promise.all(arg as Promise<unknown>[]),
    $executeRaw: async () => 0,
    mcpCatalogEntry: {
      findFirst: async (args: { where: CatalogWhere }) =>
        catalogEntries.find((entry) => catalogMatches(entry, args.where)) ?? null,
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
          catalogEntry?: CatalogWhere
        }
      }) =>
        instances.find((i) => {
          if (i.organizationId !== args.where.organizationId) return false
          if (i.scopeType !== args.where.scopeType) return false
          if (i.scopeId !== args.where.scopeId) return false
          if (args.where.catalogEntryId !== undefined) {
            return i.catalogEntryId === args.where.catalogEntryId
          }
          if (args.where.catalogEntry !== undefined) {
            const entry = catalogEntries.find((e) => e.id === i.catalogEntryId)
            if (!entry || !catalogMatches(entry, args.where.catalogEntry)) return false
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
          credentialRef: (args.data.credentialRef as string | null | undefined) ?? null,
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
        if ('credentialRef' in args.data) {
          row.credentialRef = args.data.credentialRef as string | null
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
  assert.equal(fake.instances[0]?.credentialRef, NESSIE_LEDGER_APP_API_KEY_ENV)

  // F2: the instance carries a resolvable HTTP transport, and a full transport
  // builds from catalog default + instance config with Nessie's dedicated,
  // product-bound Ledger app API key resolved as a bearer header.
  assert.deepEqual(fake.instances[0]?.transportConfig, { transport: 'http', url: DEEP_WATER_URL })
  const transport = buildAuthorizedTransport({
    catalogDefaultTransportConfig: { urlEnv: 'LEDGER_DEEPWATER_MCP_URL' },
    instanceTransportConfig: fake.instances[0]?.transportConfig,
    authConfig: { method: 'bearer' },
    secret: 'lk_test_proxy_token',
  })
  assert.equal(transport.transport, 'http')
  assert.equal((transport as { url: string }).url, DEEP_WATER_URL)
  assert.equal(
    transport.transport === 'http' ? transport.headers?.Authorization : null,
    'Bearer lk_test_proxy_token',
  )

  // The manifest's five Ledger tools carry useful schemas, are active, and
  // require an explicit per-agent grant.
  const toolNames = fake.registry.map((r) => r.toolId.split(':').pop())
  assert.deepEqual(toolNames.sort(), [
    'research_cancel',
    'research_list',
    'research_report',
    'research_start',
    'research_status',
  ])
  assert.deepEqual(
    (fake.registry.find((entry) => entry.toolId.endsWith(':research_start'))
      ?.inputSchema as { required?: string[] }).required,
    ['query'],
  )
  assert.equal(fake.registry.length, 5)
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
  assert.equal(fake.registry.length, 5)
})

test('re-enable preserves a current probe schema but enforces the Ledger app key', async () => {
  const seed = { organizationId: randomUUID(), teamId: randomUUID() }
  const instanceId = randomUUID()
  const probedSchema = { type: 'object', properties: { q: { type: 'string' } } }
  const ledgerTools = [
    'research_start',
    'research_status',
    'research_report',
    'research_list',
    'research_cancel',
  ]
  const fake = makeFake({
    ...seed,
    seedInstances: [
      {
        id: instanceId,
        organizationId: seed.organizationId,
        catalogEntryId: DEEP_WATER_CATALOG_ID,
        scopeType: 'team',
        scopeId: seed.teamId,
        credentialRef: 'legacy-direct-provider-key',
        lifecycleState: 'active',
        transportConfig: { transport: 'http', url: 'https://legacy.example.org/mcp' },
        discoveredTools: ledgerTools.map((name) => ({
          name,
          inputSchema: name === 'research_start' ? probedSchema : { type: 'object' },
        })),
      },
    ],
    seedRegistry: ledgerTools.map((name) => ({
        id: randomUUID(),
        organizationId: seed.organizationId,
        scopeKey: `mcp:${seed.organizationId}:team:${seed.teamId}`,
        toolId: `mcp:${instanceId}:${name}`,
        label: name,
        description: 'probed',
        inputSchema: name === 'research_start' ? probedSchema : { type: 'object' },
        outputSchema: null,
        status: 'active',
        metadata: {},
        mcpInstanceId: instanceId,
      })),
  })

  await ensureDeepWaterTeamInstance(asPrisma(fake), ownerContext(seed.organizationId), seed)

  // No manifest schema overwrites the current adapter probe, but routing and
  // auth are pinned to Ledger.
  assert.equal(fake.registry.length, 5)
  assert.deepEqual(
    fake.registry.find((entry) => entry.toolId.endsWith(':research_start'))?.inputSchema,
    probedSchema,
  )
  assert.deepEqual(fake.instances[0]?.transportConfig, {
    transport: 'http',
    url: DEEP_WATER_URL,
  })
  assert.equal(fake.instances[0]?.credentialRef, NESSIE_LEDGER_APP_API_KEY_ENV)
  assert.ok(fake.registry.every((entry) => entry.status === 'active'))
  assert.ok(fake.registry.every((entry) =>
    (entry.metadata as { requiresExplicitGrant?: boolean })?.requiresExplicitGrant === true))
})

test('re-enable replaces a legacy direct-provider tool contract', async () => {
  const seed = { organizationId: randomUUID(), teamId: randomUUID() }
  const instanceId = randomUUID()
  const fake = makeFake({
    ...seed,
    seedInstances: [
      {
        id: instanceId,
        organizationId: seed.organizationId,
        catalogEntryId: DEEP_WATER_CATALOG_ID,
        scopeType: 'team',
        scopeId: seed.teamId,
        credentialRef: 'legacy-oauth-secret',
        lifecycleState: 'active',
        transportConfig: { transport: 'http', url: 'https://legacy.example.org/mcp' },
        discoveredTools: [{ name: 'research_create', inputSchema: {} }],
      },
    ],
    seedRegistry: [
      {
        id: randomUUID(),
        organizationId: seed.organizationId,
        scopeKey: `mcp:${seed.organizationId}:team:${seed.teamId}`,
        toolId: `mcp:${instanceId}:research_create`,
        label: 'Create research',
        description: 'legacy',
        inputSchema: {},
        outputSchema: null,
        status: 'active',
        metadata: { requiresExplicitGrant: true },
        mcpInstanceId: instanceId,
      },
    ],
  })

  await ensureDeepWaterTeamInstance(asPrisma(fake), ownerContext(seed.organizationId), seed)

  assert.equal(fake.registry.some((entry) => entry.toolId.endsWith(':research_create')), false)
  assert.equal(fake.registry.length, 5)
  assert.equal(fake.instances[0]?.credentialRef, NESSIE_LEDGER_APP_API_KEY_ENV)
  assert.deepEqual(fake.instances[0]?.transportConfig, {
    transport: 'http',
    url: DEEP_WATER_URL,
  })
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

test('disabling DeepWater never removes a private same-name connector', async () => {
  const seed = { organizationId: randomUUID(), teamId: randomUUID() }
  const fake = makeFake(seed)
  await ensureDeepWaterTeamInstance(asPrisma(fake), ownerContext(seed.organizationId), seed)

  const publicInstance = fake.instances[0]!
  const privateCatalogId = randomUUID()
  const privateInstanceId = randomUUID()
  fake.catalogEntries.unshift({
    ...fake.catalogEntries[0]!,
    id: privateCatalogId,
    integratedProductSlugs: [],
    visibility: 'private',
    ownerUserId: randomUUID(),
    organizationId: seed.organizationId,
  })
  fake.instances.unshift({
    ...publicInstance,
    id: privateInstanceId,
    catalogEntryId: privateCatalogId,
  })
  fake.registry.unshift(...fake.registry.map((entry) => ({
    ...entry,
    id: randomUUID(),
    toolId: entry.toolId.replace(publicInstance.id, privateInstanceId),
    mcpInstanceId: privateInstanceId,
  })))

  const result = await removeDeepWaterTeamInstance(asPrisma(fake), seed)

  assert.equal(result.instanceId, publicInstance.id)
  assert.deepEqual(fake.instances.map((row) => row.id), [privateInstanceId])
  assert.ok(fake.registry.every((row) => row.mcpInstanceId === privateInstanceId))
})
