import { randomUUID } from 'node:crypto'

import type { PrismaClient } from '@prisma/client'
import type { AuthorizedActionContext } from '@nessie/schemas'

export type DeepWaterCatalogEntryFixture = {
  authConfig: unknown
  authMethod: string
  defaultTransportConfig: unknown
  id: string
  integratedProductSlugs: string[]
  label: string
  locked: boolean
  name: string
  organizationId: string | null
  ownerUserId: string | null
  status: string
  visibility: string
}

export type DeepWaterInstanceFixture = {
  catalogEntryId: string
  credentialRef: string | null
  discoveredTools: unknown
  id: string
  lifecycleState: string
  organizationId: string
  scopeId: string
  scopeType: string
  transportConfig: unknown
}

export type DeepWaterRegistryEntryFixture = {
  description: string
  id: string
  inputSchema: unknown
  label: string
  mcpInstanceId: string
  metadata: unknown
  organizationId: string
  outputSchema: unknown
  scopeKey: string
  status: string
  toolId: string
}

export type DeepWaterActiveRunFixture = {
  channelId: string | null
  externalRunId: string | null
  id: string
  result: Record<string, unknown>
  status: 'needs_setup' | 'queued' | 'running' | 'failed'
  updatedAt: Date
}

export const DEEP_WATER_CATALOG_ID = randomUUID()

type CatalogWhere = {
  id?: string
  integratedProducts?: { some: { slug: string } }
  name?: string
  status?: string
  visibility?: string
}

export const makeDeepWaterActivationFake = (seed: {
  activeRun?: boolean
  activeRuns?: DeepWaterActiveRunFixture[]
  organizationId: string
  seedCatalogEntries?: DeepWaterCatalogEntryFixture[]
  seedInstances?: DeepWaterInstanceFixture[]
  seedRegistry?: DeepWaterRegistryEntryFixture[]
  teamId: string
}) => {
  const catalogEntries: DeepWaterCatalogEntryFixture[] =
    seed.seedCatalogEntries ?? [
      {
        authConfig: { method: 'bearer' },
        authMethod: 'bearer',
        defaultTransportConfig: { urlEnv: 'LEDGER_DEEPWATER_MCP_URL' },
        id: DEEP_WATER_CATALOG_ID,
        integratedProductSlugs: ['deep-water'],
        label: 'Deep Water',
        locked: false,
        name: 'deep-water',
        organizationId: null,
        ownerUserId: null,
        status: 'published',
        visibility: 'public',
      },
    ]
  const instances: DeepWaterInstanceFixture[] =
    seed.seedInstances ? [...seed.seedInstances] : []
  const registry: DeepWaterRegistryEntryFixture[] =
    seed.seedRegistry ? [...seed.seedRegistry] : []
  const activeRuns: DeepWaterActiveRunFixture[] = seed.activeRuns
    ? [...seed.activeRuns]
    : seed.activeRun
      ? [{
          channelId: randomUUID(),
          externalRunId: 'ledger-run-active',
          id: randomUUID(),
          result: {},
          status: 'running',
          updatedAt: new Date(),
        }]
      : []
  const catalogMatches = (
    entry: DeepWaterCatalogEntryFixture,
    where: CatalogWhere,
  ): boolean =>
    (where.id === undefined || entry.id === where.id)
    && (where.name === undefined || entry.name === where.name)
    && (where.status === undefined || entry.status === where.status)
    && (where.visibility === undefined || entry.visibility === where.visibility)
    && (
      where.integratedProducts === undefined
      || entry.integratedProductSlugs.includes(
        where.integratedProducts.some.slug,
      )
    )

  const self = {
    $executeRaw: async () => 0,
    $transaction: async (arg: unknown) =>
      typeof arg === 'function'
        ? (arg as (tx: unknown) => Promise<unknown>)(self)
        : Promise.all(arg as Promise<unknown>[]),
    activeRuns,
    catalogEntries,
    instances,
    mcpCatalogEntry: {
      findFirst: async (args: { where: CatalogWhere }) =>
        catalogEntries.find((entry) => catalogMatches(entry, args.where))
        ?? null,
      findMany: async () => [],
    },
    mcpServerInstance: {
      create: async (args: { data: Record<string, unknown> }) => {
        const row: DeepWaterInstanceFixture = {
          catalogEntryId: args.data.catalogEntryId as string,
          credentialRef:
            (args.data.credentialRef as string | null | undefined) ?? null,
          discoveredTools: args.data.discoveredTools ?? [],
          id: randomUUID(),
          lifecycleState:
            (args.data.lifecycleState as string) ?? 'pending_setup',
          organizationId: args.data.organizationId as string,
          scopeId: args.data.scopeId as string,
          scopeType: args.data.scopeType as string,
          transportConfig: args.data.transportConfig ?? {},
        }
        instances.push(row)
        return row
      },
      delete: async (args: { where: { id: string } }) => {
        const index = instances.findIndex(
          (instance) => instance.id === args.where.id,
        )
        if (index >= 0) instances.splice(index, 1)
        return { id: args.where.id }
      },
      findFirst: async (args: {
        where: {
          catalogEntry?: CatalogWhere
          catalogEntryId?: string
          organizationId: string
          scopeId: string
          scopeType: string
        }
      }) =>
        instances.find((instance) => {
          if (instance.organizationId !== args.where.organizationId) return false
          if (instance.scopeType !== args.where.scopeType) return false
          if (instance.scopeId !== args.where.scopeId) return false
          if (args.where.catalogEntryId !== undefined) {
            return instance.catalogEntryId === args.where.catalogEntryId
          }
          if (args.where.catalogEntry !== undefined) {
            const entry = catalogEntries.find(
              (candidate) => candidate.id === instance.catalogEntryId,
            )
            if (
              !entry
              || !catalogMatches(entry, args.where.catalogEntry)
            ) {
              return false
            }
          }
          return true
        }) ?? null,
      findUniqueOrThrow: async (args: { where: { id: string } }) => {
        const row = instances.find(
          (instance) => instance.id === args.where.id,
        )
        if (!row) throw new Error('instance not found')
        return row
      },
      update: async (args: {
        data: Record<string, unknown>
        where: { id: string }
      }) => {
        const row = instances.find(
          (instance) => instance.id === args.where.id,
        )
        if (!row) return null
        if (typeof args.data.lifecycleState === 'string') {
          row.lifecycleState = args.data.lifecycleState
        }
        if ('credentialRef' in args.data) {
          row.credentialRef = args.data.credentialRef as string | null
        }
        if (args.data.transportConfig !== undefined) {
          row.transportConfig = args.data.transportConfig
        }
        if (args.data.discoveredTools !== undefined) {
          row.discoveredTools = args.data.discoveredTools
        }
        return row
      },
    },
    productIntegrationRun: {
      findFirst: async () =>
        activeRuns.find((run) => run.status !== 'failed') ?? null,
    },
    registry,
    team: {
      findFirst: async (args: { where: { id: string } }) =>
        args.where.id === seed.teamId ? { id: seed.teamId } : null,
    },
    toolRegistryEntry: {
      deleteMany: async (args: { where: { mcpInstanceId: string } }) => {
        for (let index = registry.length - 1; index >= 0; index -= 1) {
          if (registry[index]!.mcpInstanceId === args.where.mcpInstanceId) {
            registry.splice(index, 1)
          }
        }
        return { count: 0 }
      },
      findMany: async (args: { where: { mcpInstanceId: string } }) =>
        registry.filter(
          (entry) => entry.mcpInstanceId === args.where.mcpInstanceId,
        ),
      updateMany: async (args: {
        data: { metadata?: unknown; status?: string }
        where: { mcpInstanceId: string }
      }) => {
        let count = 0
        for (const entry of registry) {
          if (entry.mcpInstanceId === args.where.mcpInstanceId) {
            if (args.data.status) entry.status = args.data.status
            if (args.data.metadata !== undefined) {
              entry.metadata = args.data.metadata
            }
            count += 1
          }
        }
        return { count }
      },
      upsert: async (args: {
        create: DeepWaterRegistryEntryFixture
        update: { status?: string }
        where: {
          organizationId_scopeKey_toolId: { toolId: string }
        }
      }) => {
        const toolId = args.where.organizationId_scopeKey_toolId.toolId
        const existing = registry.find((entry) => entry.toolId === toolId)
        if (existing) {
          if (args.update.status) existing.status = args.update.status
          return existing
        }
        const row: DeepWaterRegistryEntryFixture = {
          ...args.create,
          id: randomUUID(),
        }
        registry.push(row)
        return row
      },
    },
  }
  return self
}

export const asDeepWaterActivationPrisma = (
  fake: ReturnType<typeof makeDeepWaterActivationFake>,
): PrismaClient => fake as unknown as PrismaClient

export const deepWaterOwnerContext = (
  organizationId: string,
): AuthorizedActionContext =>
  ({
    actionContext: {},
    actor: {
      actorId: randomUUID(),
      actorType: 'user',
      roles: ['owner'],
    },
    tenant: { organizationId },
  }) as unknown as AuthorizedActionContext
