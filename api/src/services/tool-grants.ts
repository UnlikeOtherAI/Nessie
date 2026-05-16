import type { PrismaClient } from '@prisma/client'
import type {
  ToolGrantSource,
  ToolGrantState,
  ToolRegistryEntryStatus,
  ToolRegistrySource,
  ToolRegistryTransport,
} from '@nessie/schemas'

import {
  fromPrismaToolGrantSource,
  fromPrismaToolRegistrySource,
  toPrismaToolGrantSource,
  toPrismaToolRegistrySource,
} from './tool-enum-mapping.js'

/**
 * Tool grant service.
 *
 * Spec: `docs/tool-registry-spec.md` §3.1/§11.1 + plan §6/D9.
 *
 * A `ToolGrant` row authorizes a tool for a principal: exactly one of
 * `roleId` or `agentId` is set (enforced at write time here and via partial
 * unique indexes in Postgres). Granting a tool does NOT auto-approve a
 * `pending_review` registry row — that's a separate explicit transition so
 * admins always sign off before agents can call.
 */

export const TOOL_GRANT_ERROR_CODES = {
  TOOL_NOT_FOUND: 'TOOL_REGISTRY_ENTRY_NOT_FOUND',
  GRANT_NOT_FOUND: 'TOOL_GRANT_NOT_FOUND',
  PRINCIPAL_REQUIRED: 'TOOL_GRANT_PRINCIPAL_REQUIRED',
  PRINCIPAL_AMBIGUOUS: 'TOOL_GRANT_PRINCIPAL_AMBIGUOUS',
} as const

export class ToolGrantError extends Error {
  override readonly name = 'ToolGrantError'

  constructor(public readonly code: string, message: string) {
    super(message)
  }
}

export type ToolGrantRow = {
  id: string
  toolId: string
  state: ToolGrantState
  config: unknown
  source: ToolGrantSource
  roleId: string | null
  agentId: string | null
  createdAt: Date
  updatedAt: Date
}

export type ToolRegistryRow = {
  id: string
  organizationId: string | null
  scopeKey: string
  toolId: string
  label: string
  description: string
  source: ToolRegistrySource
  transport: ToolRegistryTransport
  transportConfig: unknown
  bundleId: string | null
  mcpInstanceId: string | null
  inputSchema: unknown
  outputSchema: unknown
  tags: string[]
  status: ToolRegistryEntryStatus
  version: string
  createdBy: string
  enabled: boolean
  builtin: boolean
  createdAt: Date
  updatedAt: Date
}

export type ToolListFilters = {
  status?: ToolRegistryEntryStatus
  source?: ToolRegistrySource
  scopeKey?: string
}

type PrismaToolRegistryRow = Awaited<
  ReturnType<PrismaClient['toolRegistryEntry']['findFirst']>
>

const toToolRegistryRow = (row: NonNullable<PrismaToolRegistryRow>): ToolRegistryRow => ({
  id: row.id,
  organizationId: row.organizationId,
  scopeKey: row.scopeKey,
  toolId: row.toolId,
  label: row.label,
  description: row.description,
  source: fromPrismaToolRegistrySource(row.source),
  transport: row.transport as ToolRegistryTransport,
  transportConfig: row.transportConfig,
  bundleId: row.bundleId,
  mcpInstanceId: row.mcpInstanceId,
  inputSchema: row.inputSchema,
  outputSchema: row.outputSchema,
  tags: row.tags,
  status: row.status as ToolRegistryEntryStatus,
  version: row.version,
  createdBy: row.createdBy,
  enabled: row.enabled,
  builtin: row.builtin,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
})

export const listToolRegistry = async (
  prisma: PrismaClient,
  organizationId: string,
  filters: ToolListFilters = {},
): Promise<ToolRegistryRow[]> => {
  const rows = await prisma.toolRegistryEntry.findMany({
    where: {
      OR: [{ organizationId: null }, { organizationId }],
      ...(filters.status ? { status: filters.status } : {}),
      ...(filters.source ? { source: toPrismaToolRegistrySource(filters.source) as never } : {}),
      ...(filters.scopeKey ? { scopeKey: filters.scopeKey } : {}),
    },
    orderBy: [{ status: 'asc' }, { label: 'asc' }],
  })
  return rows.map(toToolRegistryRow)
}

export type CreateGrantInput = {
  toolRegistryEntryId: string
  state?: ToolGrantState
  config?: Record<string, unknown>
  roleId?: string | null
  agentId?: string | null
}

export const createGrant = async (
  prisma: PrismaClient,
  input: CreateGrantInput,
): Promise<ToolGrantRow> => {
  const hasRole = !!input.roleId
  const hasAgent = !!input.agentId
  if (!hasRole && !hasAgent) {
    throw new ToolGrantError(
      TOOL_GRANT_ERROR_CODES.PRINCIPAL_REQUIRED,
      'Grant requires exactly one of roleId or agentId',
    )
  }
  if (hasRole && hasAgent) {
    throw new ToolGrantError(
      TOOL_GRANT_ERROR_CODES.PRINCIPAL_AMBIGUOUS,
      'Grant requires exactly one of roleId or agentId, not both',
    )
  }

  const tool = await prisma.toolRegistryEntry.findUnique({
    where: { id: input.toolRegistryEntryId },
    select: { id: true },
  })
  if (!tool) {
    throw new ToolGrantError(
      TOOL_GRANT_ERROR_CODES.TOOL_NOT_FOUND,
      `Tool registry entry ${input.toolRegistryEntryId} not found`,
    )
  }

  const created = await prisma.toolGrant.create({
    data: {
      toolId: input.toolRegistryEntryId,
      state: input.state ?? 'allowed',
      config: (input.config ?? {}) as object,
      source: toPrismaToolGrantSource(hasAgent ? 'agent-override' : 'role') as never,
      roleId: input.roleId ?? null,
      agentId: input.agentId ?? null,
    },
  })
  return toToolGrantRow(created)
}

export const deleteGrant = async (
  prisma: PrismaClient,
  toolRegistryEntryId: string,
  grantId: string,
): Promise<boolean> => {
  const existing = await prisma.toolGrant.findFirst({
    where: { id: grantId, toolId: toolRegistryEntryId },
    select: { id: true },
  })
  if (!existing) return false
  await prisma.toolGrant.delete({ where: { id: grantId } })
  return true
}

type PrismaToolGrantRow = Awaited<
  ReturnType<PrismaClient['toolGrant']['findFirst']>
>

const toToolGrantRow = (row: NonNullable<PrismaToolGrantRow>): ToolGrantRow => ({
  id: row.id,
  toolId: row.toolId,
  state: row.state as ToolGrantState,
  config: row.config,
  source: fromPrismaToolGrantSource(row.source),
  roleId: row.roleId,
  agentId: row.agentId,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
})

/**
 * Find every effective grant for the given principal chain on a tool. Used by
 * the dispatcher to short-circuit unauthorized calls before resolving secrets.
 */
export const findGrantsForPrincipals = async (
  prisma: PrismaClient,
  toolRegistryEntryId: string,
  principals: { roleIds?: string[]; agentIds?: string[] },
): Promise<ToolGrantRow[]> => {
  const roleIds = principals.roleIds ?? []
  const agentIds = principals.agentIds ?? []
  if (roleIds.length === 0 && agentIds.length === 0) {
    return []
  }
  const rows = await prisma.toolGrant.findMany({
    where: {
      toolId: toolRegistryEntryId,
      OR: [
        ...(roleIds.length > 0 ? [{ roleId: { in: roleIds } }] : []),
        ...(agentIds.length > 0 ? [{ agentId: { in: agentIds } }] : []),
      ],
    },
  })
  return rows.map(toToolGrantRow)
}

export const hasAllowedGrantForPrincipals = async (
  prisma: PrismaClient,
  toolRegistryEntryId: string,
  principals: { roleIds?: string[]; agentIds?: string[] },
): Promise<boolean> => {
  const grants = await findGrantsForPrincipals(prisma, toolRegistryEntryId, principals)
  return grants.some((grant) => grant.state === 'allowed')
}
