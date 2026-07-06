import { type PrismaClient } from '@prisma/client'
import {
  type AuthorizedActionContext,
  type McpServerLifecycleState,
  type McpServerScopeType,
} from '@nessie/schemas'

import {
  ensureAuthConfigMatchesMethod,
  getAccessibleCatalogEntry,
  getCatalogEntry,
} from './mcp-catalog.js'
import {
  McpSecurityError,
  assertUserAuthoredMcpTransportSafe,
} from './mcp-security.js'
import { resolveCredentialRef } from './mcp-credentials.js'
import {
  MCP_INSTANCE_ERROR_CODES,
  McpInstanceError,
} from './mcp-instance-errors.js'
import {
  probeConnection,
  resolveProbeTransport,
  type ManagerFactory,
} from './mcp-instance-probe.js'
import { projectMcpToolDescriptors } from './mcp-tool-registry-projection.js'
import type { SecretResolver } from './secret-resolver.js'

export {
  MCP_INSTANCE_ERROR_CODES,
  McpInstanceError,
} from './mcp-instance-errors.js'
export {
  probeConnection,
  resolveInstanceTransport,
} from './mcp-instance-probe.js'
export type {
  ManagerFactory,
  McpProbeResult,
} from './mcp-instance-probe.js'
export {
  descriptorDiffersFromEntry,
} from './mcp-tool-registry-projection.js'

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
  lastError: string | null
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

const mapSecurityError = (error: unknown): never => {
  if (error instanceof McpSecurityError) {
    throw new McpInstanceError(
      MCP_INSTANCE_ERROR_CODES.TRANSPORT_CONFIG_INVALID,
      error.message,
    )
  }
  throw error
}

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

/**
 * A user's connector-relevant access in one organisation: their org role plus
 * the team/channel/project ids they belong to. Shared by the API's instance
 * visibility rules and the worker's personal-assistant connector tools so
 * "which connectors can this user see / manage" has exactly one definition.
 */
export type McpUserAccess = {
  role: 'owner' | 'admin' | 'member' | 'viewer' | null
  teamIds: string[]
  channelIds: string[]
  projectIds: string[]
}

export const resolveMcpUserAccess = async (
  prisma: PrismaClient,
  organizationId: string,
  userId: string,
): Promise<McpUserAccess> => {
  const [membership, teams, channels, projects] = await Promise.all([
    prisma.organizationMember.findUnique({
      where: { organizationId_userId: { organizationId, userId } },
      select: { role: true, deactivatedAt: true },
    }),
    prisma.teamMember.findMany({
      where: { userId, team: { project: { organizationId } } },
      select: { teamId: true },
    }),
    prisma.channelMember.findMany({
      where: { userId, channel: { organizationId } },
      select: { channelId: true },
    }),
    prisma.projectMember.findMany({
      where: { userId, project: { organizationId } },
      select: { projectId: true },
    }),
  ])
  return {
    role: membership && !membership.deactivatedAt ? membership.role : null,
    teamIds: teams.map((t) => t.teamId),
    channelIds: channels.map((c) => c.channelId),
    projectIds: projects.map((p) => p.projectId),
  }
}

/**
 * Owners manage every scope; admins additionally manage the shared scopes
 * ("make this connector available to the whole team/org"); everyone manages
 * their own user scope.
 */
export const canManageInstanceScope = (
  access: Pick<McpUserAccess, 'role'>,
  userId: string,
  scopeType: McpServerScopeType | string,
  scopeId: string,
): boolean => {
  if (access.role === 'owner') return true
  if (
    access.role === 'admin'
    && ['organization', 'project', 'team', 'channel'].includes(scopeType)
  ) {
    return true
  }
  return scopeType === 'user' && scopeId === userId
}

/**
 * Instances whose tools a user can potentially reach: their own user-scope
 * installs plus every shared-scope install (org-/system-wide, and the
 * team/channel/project scopes they are a member of).
 */
export const listInstancesVisibleToUser = async (
  prisma: PrismaClient,
  organizationId: string,
  userId: string,
  access?: McpUserAccess,
): Promise<McpInstanceRow[]> => {
  const resolved = access ?? (await resolveMcpUserAccess(prisma, organizationId, userId))
  return prisma.mcpServerInstance.findMany({
    where: {
      organizationId,
      OR: [
        { scopeType: 'user', scopeId: userId },
        { scopeType: 'organization' },
        { scopeType: 'system' },
        { scopeType: 'team', scopeId: { in: resolved.teamIds } },
        { scopeType: 'channel', scopeId: { in: resolved.channelIds } },
        { scopeType: 'project', scopeId: { in: resolved.projectIds } },
      ],
    },
    orderBy: [{ createdAt: 'desc' }],
  })
}

/**
 * Reject installs whose scopeId does not point at the matching entity inside
 * this organisation — a typo'd or foreign uuid would otherwise mint a scope
 * key nothing can ever match (or, worse, collide with another org's ids).
 */
const assertScopeIdInOrganization = async (
  prisma: PrismaClient,
  organizationId: string,
  scopeType: McpServerScopeType,
  scopeId: string,
): Promise<void> => {
  const fail = (): never => {
    throw new McpInstanceError(
      MCP_INSTANCE_ERROR_CODES.SCOPE_INVALID,
      `scopeId ${scopeId} does not exist in this organization for scopeType ${scopeType}`,
    )
  }
  switch (scopeType) {
    case 'system':
      return
    case 'organization':
      if (scopeId !== organizationId) fail()
      return
    case 'project': {
      const row = await prisma.project.findFirst({
        where: { id: scopeId, organizationId },
        select: { id: true },
      })
      if (!row) fail()
      return
    }
    case 'team': {
      const row = await prisma.team.findFirst({
        where: { id: scopeId, project: { organizationId } },
        select: { id: true },
      })
      if (!row) fail()
      return
    }
    case 'channel': {
      const row = await prisma.channel.findFirst({
        where: { id: scopeId, organizationId },
        select: { id: true },
      })
      if (!row) fail()
      return
    }
    case 'user': {
      const row = await prisma.organizationMember.findUnique({
        where: { organizationId_userId: { organizationId, userId: scopeId } },
        select: { id: true },
      })
      if (!row) fail()
      return
    }
    default: {
      const _never: never = scopeType
      void _never
    }
  }
}

export const createInstance = async (
  prisma: PrismaClient,
  actorContext: AuthorizedActionContext,
  input: CreateInstanceInput,
): Promise<McpInstanceRow> => {
  const organizationId = actorContext.tenant.organizationId
  const catalogEntry = await getAccessibleCatalogEntry(
    prisma,
    actorContext,
    input.catalogEntryId,
  )
  if (!catalogEntry) {
    throw new McpInstanceError(
      MCP_INSTANCE_ERROR_CODES.CATALOG_ENTRY_NOT_FOUND,
      `Catalog entry ${input.catalogEntryId} not found in this scope`,
    )
  }

  await assertScopeIdInOrganization(prisma, organizationId, input.scopeType, input.scopeId)

  try {
    await assertUserAuthoredMcpTransportSafe(catalogEntry.defaultTransportConfig)
    await assertUserAuthoredMcpTransportSafe(input.transportConfig)
  } catch (error) {
    mapSecurityError(error)
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
  options: ProbeOptions = {},
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
  const credentialRef = await resolveProbeCredentialRef(
    prisma,
    organizationId,
    instance,
    options.probeUserId,
  )
  const transport = await resolveProbeTransport(
    { ...instance, credentialRef },
    catalogEntry,
    options.secretResolver,
  )
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
 * Drift handling (task #18): a re-probe whose descriptors differ from the
 * stored `ToolRegistryEntry` (label / description / inputSchema / outputSchema)
 * resets the affected entries' status to `pending_review`, and any registry
 * entry whose tool has been REMOVED from the server is likewise reset (kept
 * enabled — disabling silently is more destructive than re-review).
 */
export const refreshInstance = async (
  prisma: PrismaClient,
  organizationId: string,
  id: string,
  options: ProbeOptions = {},
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
export type ProbeOptions = {
  managerFactory?: ManagerFactory
  secretResolver?: SecretResolver
  /**
   * Probe with this user's credential (their override, falling back to the
   * instance default via the 7-level chain). This is what makes shared OAuth
   * connectors testable: each user connects their own account, and their
   * probe runs with their own token.
   */
  probeUserId?: string
}

const resolveProbeCredentialRef = async (
  prisma: PrismaClient,
  organizationId: string,
  instance: McpInstanceRow,
  probeUserId?: string,
): Promise<string | null> => {
  if (!probeUserId) return instance.credentialRef
  return resolveCredentialRef(prisma, instance.id, {
    userId: probeUserId,
    organizationId,
  })
}

export const testInstance = async (
  prisma: PrismaClient,
  organizationId: string,
  id: string,
  options: ProbeOptions = {},
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

  // Sanity-check the auth config before opening anything. Bearer auth is also
  // applied to probes so authenticated MCP servers can be tested before use.
  ensureAuthConfigMatchesMethod(catalogEntry.authMethod, catalogEntry.authConfig)

  const credentialRef = await resolveProbeCredentialRef(
    prisma,
    organizationId,
    instance,
    options.probeUserId,
  )
  const transport = await resolveProbeTransport(
    { ...instance, credentialRef },
    catalogEntry,
    options.secretResolver,
  )
  const probe = await probeConnection(transport, options.managerFactory)

  const now = new Date()
  if (!probe.ok) {
    const failureMessage = probe.error ?? 'unknown error'
    // No $transaction wrapper here (unlike the success path below): the failure
    // branch has no registry side effects to coordinate, and the only non-idempotent
    // write is `healthFailureCount: { increment: 1 }` which Postgres serialises
    // atomically. Wrapping this in a transaction would add overhead without benefit.
    // If you add registry side effects to this branch, wrap it in $transaction.
    await prisma.mcpServerInstance.update({
      where: { id },
      data: {
        lifecycleState: 'error',
        healthFailureCount: { increment: 1 },
        healthLastCheckedAt: now,
        lastError: failureMessage,
      },
    })
    throw new McpInstanceError(
      MCP_INSTANCE_ERROR_CODES.PROBE_FAILED,
      `MCP probe failed: ${failureMessage}`,
    )
  }

  const descriptors = probe.descriptors ?? []

  return prisma.$transaction(async (tx) => {
    const updated = await tx.mcpServerInstance.update({
      where: { id },
      data: {
        discoveredTools: descriptors as unknown as object,
        lifecycleState: 'active',
        healthFailureCount: 0,
        healthLastCheckedAt: now,
        lastError: null,
      },
    })

    await projectMcpToolDescriptors(tx, { organizationId, instance, descriptors })

    return updated
  })
}
