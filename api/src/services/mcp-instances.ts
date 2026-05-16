import { Prisma, type PrismaClient } from '@prisma/client'
import { McpClientManager, type McpToolDescriptor } from '@nessie/mcp-client'
import {
  McpTransportConfigSchema,
  type AuthorizedActionContext,
  type McpServerLifecycleState,
  type McpServerScopeType,
  type McpTransportConfig,
} from '@nessie/schemas'

import { ensureAuthConfigMatchesMethod, getCatalogEntry } from './mcp-catalog.js'
import { toPrismaToolRegistrySource } from './tool-enum-mapping.js'

/**
 * MCP server instance service.
 *
 * Spec: `docs/external-tool-integration.md` §2 (Installation Flow) + plan §6.
 *
 * One `McpServerInstance` row per `catalogEntryId × (scopeType, scopeId)`.
 * After install the row sits in `pending_setup` until a successful probe
 * (`testInstance`) runs `tools/list` and projects discovered tools into the
 * `ToolRegistryEntry` table at `status: 'pending_review'` (plan D9).
 */

export const MCP_INSTANCE_ERROR_CODES = {
  NOT_FOUND: 'MCP_INSTANCE_NOT_FOUND',
  CATALOG_ENTRY_NOT_FOUND: 'MCP_INSTANCE_CATALOG_ENTRY_NOT_FOUND',
  DUPLICATE_SCOPE: 'MCP_INSTANCE_DUPLICATE_SCOPE',
  TRANSPORT_CONFIG_INVALID: 'MCP_INSTANCE_TRANSPORT_CONFIG_INVALID',
  PROBE_FAILED: 'MCP_INSTANCE_PROBE_FAILED',
} as const

export class McpInstanceError extends Error {
  override readonly name = 'McpInstanceError'

  constructor(public readonly code: string, message: string) {
    super(message)
  }
}

export type McpInstanceRow = {
  id: string
  catalogEntryId: string
  organizationId: string
  scopeType: McpServerScopeType
  scopeId: string
  credentialRef: string | null
  transportConfig: unknown
  discoveredTools: unknown
  lifecycleState: McpServerLifecycleState
  healthLastCheckedAt: Date | null
  healthFailureCount: number
  installedBy: string
  createdAt: Date
  updatedAt: Date
}

export type CreateInstanceInput = {
  catalogEntryId: string
  scopeType: McpServerScopeType
  scopeId: string
  credentialRef?: string | null
  transportConfig?: Record<string, unknown>
}

const toRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}

const isUniqueViolation = (error: unknown): boolean =>
  typeof error === 'object'
  && error !== null
  && 'code' in error
  && (error as { code?: unknown }).code === 'P2002'

/**
 * Build a stable scope-key string for projecting discovered MCP tools into
 * `ToolRegistryEntry`. The base CRUD-side registry uses a string `scopeKey`
 * (see `services/tools.ts`); we mirror that here so MCP-emitted rows compose
 * with builtin/custom rows under the same unique constraint.
 */
const toRegistryScopeKey = (
  organizationId: string,
  scopeType: McpServerScopeType,
  scopeId: string,
): string => `mcp:${organizationId}:${scopeType}:${scopeId}`

const toRegistryToolId = (instanceId: string, toolName: string): string =>
  `mcp:${instanceId}:${toolName}`

export const listInstances = async (
  prisma: PrismaClient,
  organizationId: string,
  filters: { scopeType?: McpServerScopeType; scopeId?: string } = {},
): Promise<McpInstanceRow[]> => {
  return prisma.mcpServerInstance.findMany({
    where: {
      organizationId,
      ...(filters.scopeType ? { scopeType: filters.scopeType } : {}),
      ...(filters.scopeId ? { scopeId: filters.scopeId } : {}),
    },
    orderBy: [{ createdAt: 'desc' }],
  })
}

export const getInstance = async (
  prisma: PrismaClient,
  organizationId: string,
  id: string,
): Promise<McpInstanceRow | null> => {
  return prisma.mcpServerInstance.findFirst({
    where: { id, organizationId },
  })
}

export const createInstance = async (
  prisma: PrismaClient,
  actorContext: AuthorizedActionContext,
  input: CreateInstanceInput,
): Promise<McpInstanceRow> => {
  const organizationId = actorContext.tenant.organizationId
  const catalogEntry = await getCatalogEntry(prisma, organizationId, input.catalogEntryId)
  if (!catalogEntry) {
    throw new McpInstanceError(
      MCP_INSTANCE_ERROR_CODES.CATALOG_ENTRY_NOT_FOUND,
      `Catalog entry ${input.catalogEntryId} not found in this scope`,
    )
  }

  try {
    return await prisma.mcpServerInstance.create({
      data: {
        catalogEntryId: input.catalogEntryId,
        organizationId,
        scopeType: input.scopeType,
        scopeId: input.scopeId,
        credentialRef: input.credentialRef ?? null,
        transportConfig: toRecord(input.transportConfig) as object,
        discoveredTools: [] as object,
        lifecycleState: 'pending_setup',
        healthFailureCount: 0,
        installedBy: actorContext.actor.actorId,
      },
    })
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new McpInstanceError(
        MCP_INSTANCE_ERROR_CODES.DUPLICATE_SCOPE,
        'An MCP server is already installed for this catalog entry at this scope',
      )
    }
    throw error
  }
}

export const deleteInstance = async (
  prisma: PrismaClient,
  organizationId: string,
  id: string,
): Promise<boolean> => {
  const existing = await getInstance(prisma, organizationId, id)
  if (!existing) return false
  await prisma.mcpServerInstance.delete({ where: { id } })
  return true
}

/**
 * Merge an instance's `transportConfig` with the catalog entry's
 * `defaultTransportConfig`, with the instance value winning. The merged value
 * must satisfy `McpTransportConfigSchema` (stdio | http | sse | ws) before we
 * pass it to the universal client.
 */
export const resolveInstanceTransport = (
  instance: McpInstanceRow,
  catalogEntry: { defaultTransportConfig: unknown },
): McpTransportConfig => {
  const merged = {
    ...toRecord(catalogEntry.defaultTransportConfig),
    ...toRecord(instance.transportConfig),
  }
  const parsed = McpTransportConfigSchema.safeParse(merged)
  if (!parsed.success) {
    throw new McpInstanceError(
      MCP_INSTANCE_ERROR_CODES.TRANSPORT_CONFIG_INVALID,
      `Resolved transport config is invalid: ${
        parsed.error.issues[0]?.message ?? 'shape mismatch'
      }`,
    )
  }
  return parsed.data
}

const transportToConnectionSpec = (
  config: McpTransportConfig,
): Parameters<McpClientManager['open']>[0] => {
  switch (config.transport) {
    case 'stdio':
      return {
        transport: 'stdio',
        command: config.command,
        args: config.args ?? [],
        env: config.env,
      }
    case 'http':
      return { transport: 'http', url: config.url, headers: config.headers }
    case 'sse':
      return { transport: 'sse', url: config.url, headers: config.headers }
    case 'ws':
      // The universal client supports stdio/http/sse only today (per plan §5
      // and packages/mcp-client/src/types.ts). Surface a typed error rather
      // than a silent crash so the UI can prompt for an alternative.
      throw new McpInstanceError(
        MCP_INSTANCE_ERROR_CODES.TRANSPORT_CONFIG_INVALID,
        'ws transport is not yet supported by the MCP client',
      )
    default: {
      const _never: never = config
      void _never
      throw new McpInstanceError(
        MCP_INSTANCE_ERROR_CODES.TRANSPORT_CONFIG_INVALID,
        'Unsupported MCP transport',
      )
    }
  }
}

export type ManagerFactory = () => McpClientManager

const defaultManagerFactory: ManagerFactory = () => new McpClientManager()

const stringifyError = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

/**
 * Probe a freshly-installed instance: open the connection, run `tools/list`,
 * persist the discovered tool descriptors, project them into
 * `ToolRegistryEntry` rows (all `status: 'pending_review'`), then close the
 * connection. On failure the instance moves to `error` and the failure counter
 * increments.
 */
export const testInstance = async (
  prisma: PrismaClient,
  organizationId: string,
  id: string,
  options: { managerFactory?: ManagerFactory } = {},
): Promise<McpInstanceRow> => {
  const instance = await getInstance(prisma, organizationId, id)
  if (!instance) {
    throw new McpInstanceError(
      MCP_INSTANCE_ERROR_CODES.NOT_FOUND,
      `MCP server instance ${id} not found`,
    )
  }

  const catalogEntry = await getCatalogEntry(prisma, organizationId, instance.catalogEntryId)
  if (!catalogEntry) {
    throw new McpInstanceError(
      MCP_INSTANCE_ERROR_CODES.CATALOG_ENTRY_NOT_FOUND,
      `Catalog entry ${instance.catalogEntryId} not found`,
    )
  }

  // Sanity-check the auth config before opening anything. The actual secret
  // injection happens at call time in the worker dispatcher.
  ensureAuthConfigMatchesMethod(catalogEntry.authMethod, catalogEntry.authConfig)

  const transport = resolveInstanceTransport(instance, catalogEntry)
  const manager = (options.managerFactory ?? defaultManagerFactory)()

  let descriptors: McpToolDescriptor[]
  try {
    const connectionId = await manager.open(transportToConnectionSpec(transport))
    try {
      descriptors = await manager.listTools(connectionId)
    } finally {
      await manager.close(connectionId)
    }
  } catch (error) {
    await prisma.mcpServerInstance.update({
      where: { id },
      data: {
        lifecycleState: 'error',
        healthFailureCount: { increment: 1 },
        healthLastCheckedAt: new Date(),
      },
    })
    throw new McpInstanceError(
      MCP_INSTANCE_ERROR_CODES.PROBE_FAILED,
      `MCP probe failed: ${stringifyError(error)}`,
    )
  } finally {
    await manager.closeAll().catch(() => undefined)
  }

  const scopeKey = toRegistryScopeKey(organizationId, instance.scopeType, instance.scopeId)
  const now = new Date()

  return prisma.$transaction(async (tx) => {
    const updated = await tx.mcpServerInstance.update({
      where: { id },
      data: {
        discoveredTools: descriptors as unknown as object,
        lifecycleState: 'active',
        healthFailureCount: 0,
        healthLastCheckedAt: now,
      },
    })

    const prismaSource = toPrismaToolRegistrySource('mcp-remote') as never
    for (const descriptor of descriptors) {
      const toolId = toRegistryToolId(id, descriptor.name)
      await tx.toolRegistryEntry.upsert({
        where: {
          scopeKey_toolId: { scopeKey, toolId },
        },
        create: {
          organizationId,
          scopeKey,
          toolId,
          label: descriptor.title ?? descriptor.name,
          description: descriptor.description ?? '',
          safe: false,
          builtin: false,
          enabled: true,
          handlerKind: 'mcp',
          metadata: {} as object,
          source: prismaSource,
          transport: 'mcp',
          transportConfig: {
            transport: 'mcp',
            serverId: id,
            toolName: descriptor.name,
          } as object,
          mcpInstanceId: id,
          inputSchema: (descriptor.inputSchema ?? {}) as object,
          outputSchema: descriptor.outputSchema
            ? (descriptor.outputSchema as object)
            : undefined,
          tags: [],
          status: 'pending_review',
          version: '0.0.0',
          createdBy: 'mcp',
        },
        update: {
          label: descriptor.title ?? descriptor.name,
          description: descriptor.description ?? '',
          source: prismaSource,
          transport: 'mcp',
          transportConfig: {
            transport: 'mcp',
            serverId: id,
            toolName: descriptor.name,
          } as object,
          mcpInstanceId: id,
          inputSchema: (descriptor.inputSchema ?? {}) as object,
          outputSchema: descriptor.outputSchema
            ? (descriptor.outputSchema as object)
            : Prisma.JsonNull,
        },
      })
    }

    return updated
  })
}
