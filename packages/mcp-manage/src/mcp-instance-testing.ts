import type { PrismaClient } from '@prisma/client'

import {
  ensureAuthConfigMatchesMethod,
  getCatalogEntry,
} from './mcp-catalog.js'
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
import type { McpInstanceRow } from './mcp-instances.js'
import { projectMcpToolDescriptors } from './mcp-tool-registry-projection.js'
import type { SecretResolver } from './secret-resolver.js'

/**
 * Probe options shared by test, refresh, and healthcheck operations.
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

export type HealthcheckResult = {
  healthy: boolean
  latencyMs: number
  lastError?: string
}

const getInstance = async (
  prisma: PrismaClient,
  organizationId: string,
  id: string,
): Promise<McpInstanceRow | null> =>
  prisma.mcpServerInstance.findFirst({
    where: { id, organizationId },
  })

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

/**
 * Synchronous health probe. Reuses the same probe path as `testInstance`, but
 * does not mutate lifecycle state or the failure counter.
 */
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
 * Re-probe an instance and return its updated row even when the connection
 * fails, allowing callers to render the persisted error lifecycle state.
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
 * Probe a freshly-installed instance, persist its lifecycle state, and project
 * successful `tools/list` descriptors into the tool registry.
 */
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
