import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import type { PrismaClient } from '@prisma/client'
import type { AuthorizedActionContext } from '@nessie/schemas'

import {
  ensureDeepWaterTeamInstance,
  removeDeepWaterTeamInstance,
} from '../src/services/deepwater-activation.js'

/**
 * Team-scoped DeepWater activation: enabling for a team creates a team-scoped
 * tool-projecting instance (so `research_*` land in `ToolRegistryEntry` as
 * active, grantable rows); disabling removes it. Uses an in-memory Prisma fake
 * — no MCP traffic (DeepWater tools come from the plugin manifest, not a probe).
 */

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
  mcpInstanceId: string
}

const DEEP_WATER_CATALOG_ID = randomUUID()

const makeFake = (seed: { organizationId: string; teamId: string; withCatalog?: boolean }) => {
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
          defaultTransportConfig: { urlEnv: 'DEEP_WATER_MCP_URL' },
          locked: false,
          label: 'Deep Water',
          ownerUserId: null,
          organizationId: null,
        },
      ]
  const instances: Instance[] = []
  const registry: RegistryEntry[] = []

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
        where: { organizationId: string; catalogEntryId: string; scopeType: string; scopeId: string }
      }) =>
        instances.find(
          (i) =>
            i.organizationId === args.where.organizationId
            && i.catalogEntryId === args.where.catalogEntryId
            && i.scopeType === args.where.scopeType
            && i.scopeId === args.where.scopeId,
        ) ?? null,
      create: async (args: { data: Omit<Instance, 'id'> & Record<string, unknown> }) => {
        const row: Instance = {
          id: randomUUID(),
          organizationId: args.data.organizationId,
          catalogEntryId: args.data.catalogEntryId,
          scopeType: args.data.scopeType,
          scopeId: args.data.scopeId,
          lifecycleState: args.data.lifecycleState,
        }
        instances.push(row)
        return row
      },
      update: async (args: { where: { id: string }; data: { lifecycleState?: string } }) => {
        const row = instances.find((i) => i.id === args.where.id)
        if (row && args.data.lifecycleState) row.lifecycleState = args.data.lifecycleState
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
      updateMany: async (args: { where: { mcpInstanceId: string }; data: { status: string } }) => {
        let count = 0
        for (const r of registry) {
          if (r.mcpInstanceId === args.where.mcpInstanceId) {
            r.status = args.data.status
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

test('enabling DeepWater creates a team-scoped instance and projects active research tools', async () => {
  const seed = { organizationId: randomUUID(), teamId: randomUUID() }
  const fake = makeFake(seed)

  const instance = await ensureDeepWaterTeamInstance(asPrisma(fake), ownerContext(seed.organizationId), seed)

  assert.ok(instance)
  assert.equal(fake.instances.length, 1)
  assert.equal(fake.instances[0]?.scopeType, 'team')
  assert.equal(fake.instances[0]?.scopeId, seed.teamId)
  assert.equal(fake.instances[0]?.lifecycleState, 'active')

  // The manifest's six research tools are projected and all active/grantable.
  const toolNames = fake.registry.map((r) => r.toolId.split(':').pop())
  assert.ok(toolNames.includes('research_create'))
  assert.ok(toolNames.includes('research_get'))
  assert.equal(fake.registry.length, 6)
  assert.ok(fake.registry.every((r) => r.status === 'active'))
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
