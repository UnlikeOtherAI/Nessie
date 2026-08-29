import { isAdminActor } from '@nessie/schemas'
import { type PrismaClient } from '@prisma/client'
import {
  type AuthorizedActionContext,
  type McpServerLifecycleState,
  type McpServerScopeType,
} from '@nessie/schemas'

import {
  getAccessibleCatalogEntry,
  isAdminUser,
} from './mcp-catalog.js'
import { findApplicableLock } from './mcp-catalog-endpoint-lock.js'
import {
  McpSecurityError,
  assertUserAuthoredMcpTransportSafe,
} from './mcp-security.js'
import {
  MCP_INSTANCE_ERROR_CODES,
  McpInstanceError,
} from './mcp-instance-errors.js'
import {
  assertCatalogLifecycleIsUserManaged,
  isManagedIntegrationCatalogEntry,
} from './managed-products.js'
import { isOperatorEnvSecretRef } from './secret-resolver.js'

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
export {
  healthcheckInstance,
  refreshInstance,
  testInstance,
} from './mcp-instance-testing.js'
export type {
  HealthcheckResult,
  ProbeOptions,
} from './mcp-instance-testing.js'

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
  /** First-party provisioning only; user/API install surfaces must omit it. */
  managedProvision?: boolean
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
  if (
    !input.managedProvision
    && await isManagedIntegrationCatalogEntry(prisma, input.catalogEntryId)
  ) {
    throw new McpInstanceError(
      MCP_INSTANCE_ERROR_CODES.MANAGED_BY_INTEGRATION,
      'This first-party connector is provisioned from Integrations and uses Nessie SSO.',
    )
  }
  if (
    input.credentialRef
    && (
      !input.managedProvision
      || !isOperatorEnvSecretRef(input.credentialRef)
    )
  ) {
    throw new McpInstanceError(
      MCP_INSTANCE_ERROR_CODES.CREDENTIAL_REF_FORBIDDEN,
      'Connector credentials must be stored through the encrypted secret endpoint.',
    )
  }

  // Admin lock: members cannot install a locked connector (or the same
  // endpoint re-registered under another name). Owners/admins are exempt.
  // The role check is DB-authoritative because worker-derived actor contexts
  // (the personal assistant) may carry no JWT roles.
  const lock = await findApplicableLock(prisma, organizationId, catalogEntry)
  if (lock) {
    const isAdmin =
      isAdminActor(actorContext)
      || (await isAdminUser(prisma, organizationId, actorContext.actor.actorId))
    if (!isAdmin) {
      throw new McpInstanceError(
        MCP_INSTANCE_ERROR_CODES.LOCKED,
        `"${lock.label}" is locked by your organisation's admins and cannot be installed`,
      )
    }
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
  await assertCatalogLifecycleIsUserManaged(prisma, existing.catalogEntryId)
  await prisma.mcpServerInstance.delete({ where: { id } })
  return true
}
