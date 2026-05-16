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
 * Structured outcome of a single probe attempt. Returned from `probeConnection`
 * and surfaced via `testInstance` so callers (route handler, admin UI) can
 * render lifecycle transitions accurately. `ok: true` means we opened the
 * connection, ran `tools/list`, and received a well-formed descriptor array
 * (which may legitimately be empty for a server that has not registered any
 * tools yet — that is still a successful handshake).
 */
export type McpProbeResult = {
  ok: boolean
  error?: string
  latencyMs: number
  toolCount?: number
  descriptors?: McpToolDescriptor[]
}

/**
 * Run a one-shot probe against an already-resolved transport spec. Pure with
 * respect to Prisma: takes a `ManagerFactory` so tests can inject a fake
 * `McpClientManager` and assert on probe outcomes without touching the DB.
 *
 * A throw at any stage (transport, protocol, auth, timeout) is captured as
 * `{ ok: false, error }`. A return shape from `listTools` that is not an array
 * is treated as a malformed handshake — also `ok: false`. Empty arrays are
 * considered a successful handshake.
 */
export const probeConnection = async (
  transport: McpTransportConfig,
  managerFactory: ManagerFactory = defaultManagerFactory,
): Promise<McpProbeResult> => {
  const manager = managerFactory()
  const startedAt = Date.now()
  try {
    const connectionId = await manager.open(transportToConnectionSpec(transport))
    try {
      const descriptors = await manager.listTools(connectionId)
      if (!Array.isArray(descriptors)) {
        return {
          ok: false,
          error: 'tools/list response was not an array',
          latencyMs: Date.now() - startedAt,
        }
      }
      return {
        ok: true,
        latencyMs: Date.now() - startedAt,
        toolCount: descriptors.length,
        descriptors,
      }
    } finally {
      await manager.close(connectionId).catch(() => undefined)
    }
  } catch (error) {
    return {
      ok: false,
      error: stringifyError(error),
      latencyMs: Date.now() - startedAt,
    }
  } finally {
    await manager.closeAll().catch(() => undefined)
  }
}

/**
 * Synchronous health probe (task #20, plan §6 `/healthcheck`). Reuses
 * `probeConnection` so the success criteria stay identical to `testInstance`,
 * but does NOT mutate the instance row — admins can poll this without
 * advancing lifecycle state or moving the `healthFailureCount` needle.
 *
 * The public HTTP shape is `{ healthy, latencyMs, lastError? }`; that mapping
 * lives in the route layer (`routes/mcp.ts`), this service returns the raw
 * probe outcome unchanged.
 */
export type HealthcheckResult = {
  healthy: boolean
  latencyMs: number
  lastError?: string
}

export const healthcheckInstance = async (
  prisma: PrismaClient,
  organizationId: string,
  id: string,
  options: { managerFactory?: ManagerFactory } = {},
): Promise<HealthcheckResult> => {
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
  ensureAuthConfigMatchesMethod(catalogEntry.authMethod, catalogEntry.authConfig)
  const transport = resolveInstanceTransport(instance, catalogEntry)
  const probe = await probeConnection(transport, options.managerFactory)
  return {
    healthy: probe.ok,
    latencyMs: probe.latencyMs,
    ...(probe.ok ? {} : { lastError: probe.error ?? 'unknown error' }),
  }
}

/**
 * Refresh an installed instance (task #20, plan §6 `/refresh`).
 *
 * Re-runs the same probe + registry projection as `testInstance` so a newly
 * added tool on the remote server shows up in `ToolRegistryEntry`. Unlike
 * `testInstance`, refresh is intentionally tolerant of probe failure — the
 * route handler returns the up-to-date instance row either way so the admin
 * UI can render the new lifecycle state (`error` with `healthFailureCount`
 * incremented) without the 502 round-trip that the `test` endpoint emits.
 *
 * TODO(task #18): when the probed schema diverges from the stored
 * `ToolRegistryEntry` (input/output/label/description), the affected entries'
 * status should reset to `pending_review`. Scope here is just probe +
 * projection; status-reset semantics land in #18.
 */
export const refreshInstance = async (
  prisma: PrismaClient,
  organizationId: string,
  id: string,
  options: { managerFactory?: ManagerFactory } = {},
): Promise<McpInstanceRow> => {
  try {
    return await testInstance(prisma, organizationId, id, options)
  } catch (error) {
    if (error instanceof McpInstanceError && error.code === MCP_INSTANCE_ERROR_CODES.PROBE_FAILED) {
      const refreshed = await getInstance(prisma, organizationId, id)
      if (!refreshed) {
        throw new McpInstanceError(
          MCP_INSTANCE_ERROR_CODES.NOT_FOUND,
          `MCP server instance ${id} not found`,
        )
      }
      return refreshed
    }
    throw error
  }
}

/**
 * Probe a freshly-installed instance: open the connection, run `tools/list`,
 * persist the discovered tool descriptors on success, and project them into
 * `ToolRegistryEntry` rows (all `status: 'pending_review'`).
 *
 * Outcome handling (fixes HIGH finding from Slice C review, task #22):
 *
 * - Probe succeeds → `lifecycleState = 'active'`, `healthFailureCount = 0`,
 *   `healthLastCheckedAt = now`. Discovered tools projected into the registry.
 * - Probe fails (transport error, auth failure, malformed `tools/list`) →
 *   `lifecycleState = 'error'`, `healthFailureCount` incremented,
 *   `healthLastCheckedAt = now`. Lifecycle is NEVER advanced to `active`.
 *   A typed `McpInstanceError(PROBE_FAILED)` carrying the failure reason is
 *   thrown so the route handler can return 502 with the error message — the
 *   admin UI surfaces this verbatim.
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
  const probe = await probeConnection(transport, options.managerFactory)

  const now = new Date()
  if (!probe.ok) {
    await prisma.mcpServerInstance.update({
      where: { id },
      data: {
        lifecycleState: 'error',
        healthFailureCount: { increment: 1 },
        healthLastCheckedAt: now,
      },
    })
    throw new McpInstanceError(
      MCP_INSTANCE_ERROR_CODES.PROBE_FAILED,
      `MCP probe failed: ${probe.error ?? 'unknown error'}`,
    )
  }

  const descriptors = probe.descriptors ?? []
  const scopeKey = toRegistryScopeKey(organizationId, instance.scopeType, instance.scopeId)

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
