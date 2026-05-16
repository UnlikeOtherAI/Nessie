import type { PrismaClient } from '@prisma/client'
import {
  McpServerAuthConfigSchema,
  type AuthorizedActionContext,
  type McpCatalogAuthMethod,
  type McpCatalogProtocol,
  type McpCatalogStatus,
  type McpServerAuthConfig,
} from '@nessie/schemas'

/**
 * MCP App Store catalog service.
 *
 * Spec: `docs/external-tool-integration.md` §2 + plan §6.
 *
 * `McpCatalogEntry` rows are admin-managed definitions of installable MCP
 * servers. A `null` `organizationId` marks a system-level definition that's
 * visible everywhere; otherwise the entry is scoped to a single org.
 */

export const MCP_CATALOG_ERROR_CODES = {
  NOT_FOUND: 'MCP_CATALOG_ENTRY_NOT_FOUND',
  AUTH_CONFIG_INVALID: 'MCP_CATALOG_AUTH_CONFIG_INVALID',
  AUTH_METHOD_MISMATCH: 'MCP_CATALOG_AUTH_METHOD_MISMATCH',
  DUPLICATE_NAME: 'MCP_CATALOG_ENTRY_DUPLICATE_NAME',
} as const

export class McpCatalogError extends Error {
  override readonly name = 'McpCatalogError'

  constructor(public readonly code: string, message: string) {
    super(message)
  }
}

export type McpCatalogEntryRow = {
  id: string
  organizationId: string | null
  name: string
  label: string
  description: string
  protocol: McpCatalogProtocol
  authMethod: McpCatalogAuthMethod
  authConfig: unknown
  defaultTransportConfig: unknown
  iconUrl: string | null
  vendor: string | null
  sourceUrl: string | null
  signature: string | null
  status: McpCatalogStatus
  createdBy: string
  createdAt: Date
  updatedAt: Date
}

export type CreateCatalogEntryInput = {
  name: string
  label: string
  description?: string
  protocol: McpCatalogProtocol
  authMethod: McpCatalogAuthMethod
  /**
   * Validated via `ensureAuthConfigMatchesMethod` against the discriminated
   * union schema. Accept `unknown` so route layers don't have to align their
   * Zod inference exactly with the post-parse type (defaults vs optionals).
   */
  authConfig: unknown
  defaultTransportConfig?: Record<string, unknown>
  iconUrl?: string | null
  vendor?: string | null
  sourceUrl?: string | null
  signature?: string | null
  /** Org scope (defaults to caller's tenant org). Pass `null` for a system entry. */
  organizationId?: string | null
}

export type UpdateCatalogEntryInput = Partial<{
  label: string
  description: string
  protocol: McpCatalogProtocol
  authMethod: McpCatalogAuthMethod
  authConfig: unknown
  defaultTransportConfig: Record<string, unknown>
  iconUrl: string | null
  vendor: string | null
  sourceUrl: string | null
  signature: string | null
  status: McpCatalogStatus
}>

export const ensureAuthConfigMatchesMethod = (
  authMethod: McpCatalogAuthMethod,
  authConfig: unknown,
): McpServerAuthConfig => {
  const parsed = McpServerAuthConfigSchema.safeParse(authConfig)
  if (!parsed.success) {
    throw new McpCatalogError(
      MCP_CATALOG_ERROR_CODES.AUTH_CONFIG_INVALID,
      `Invalid authConfig: ${parsed.error.issues[0]?.message ?? 'shape mismatch'}`,
    )
  }
  if (parsed.data.method !== authMethod) {
    throw new McpCatalogError(
      MCP_CATALOG_ERROR_CODES.AUTH_METHOD_MISMATCH,
      `authConfig.method (${parsed.data.method}) does not match authMethod (${authMethod})`,
    )
  }
  return parsed.data
}

const toJsonRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}

export const listCatalogEntries = async (
  prisma: PrismaClient,
  organizationId: string,
  filters: { status?: McpCatalogStatus } = {},
): Promise<McpCatalogEntryRow[]> => {
  return prisma.mcpCatalogEntry.findMany({
    where: {
      OR: [{ organizationId: null }, { organizationId }],
      ...(filters.status ? { status: filters.status } : {}),
    },
    orderBy: [{ status: 'asc' }, { label: 'asc' }],
  })
}

export const getCatalogEntry = async (
  prisma: PrismaClient,
  organizationId: string,
  id: string,
): Promise<McpCatalogEntryRow | null> => {
  return prisma.mcpCatalogEntry.findFirst({
    where: {
      id,
      OR: [{ organizationId: null }, { organizationId }],
    },
  })
}

const isUniqueViolation = (error: unknown): boolean =>
  typeof error === 'object'
  && error !== null
  && 'code' in error
  && (error as { code?: unknown }).code === 'P2002'

export const createCatalogEntry = async (
  prisma: PrismaClient,
  actorContext: AuthorizedActionContext,
  input: CreateCatalogEntryInput,
): Promise<McpCatalogEntryRow> => {
  const authConfig = ensureAuthConfigMatchesMethod(input.authMethod, input.authConfig)
  const organizationId =
    input.organizationId === undefined ? actorContext.tenant.organizationId : input.organizationId

  try {
    return await prisma.mcpCatalogEntry.create({
      data: {
        organizationId,
        name: input.name,
        label: input.label,
        description: input.description ?? '',
        protocol: input.protocol,
        authMethod: input.authMethod,
        authConfig: authConfig as object,
        defaultTransportConfig: toJsonRecord(input.defaultTransportConfig) as object,
        iconUrl: input.iconUrl ?? null,
        vendor: input.vendor ?? null,
        sourceUrl: input.sourceUrl ?? null,
        signature: input.signature ?? null,
        status: 'draft',
        createdBy: actorContext.actor.actorId,
      },
    })
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new McpCatalogError(
        MCP_CATALOG_ERROR_CODES.DUPLICATE_NAME,
        `An MCP catalog entry named "${input.name}" already exists in this scope`,
      )
    }
    throw error
  }
}

export const updateCatalogEntry = async (
  prisma: PrismaClient,
  organizationId: string,
  id: string,
  input: UpdateCatalogEntryInput,
): Promise<McpCatalogEntryRow | null> => {
  const existing = await getCatalogEntry(prisma, organizationId, id)
  if (!existing) return null

  if (input.authConfig !== undefined || input.authMethod !== undefined) {
    const nextMethod = input.authMethod ?? existing.authMethod
    const nextConfig = input.authConfig ?? existing.authConfig
    ensureAuthConfigMatchesMethod(nextMethod, nextConfig)
  }

  return prisma.mcpCatalogEntry.update({
    where: { id },
    data: {
      ...(input.label !== undefined ? { label: input.label } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.protocol !== undefined ? { protocol: input.protocol } : {}),
      ...(input.authMethod !== undefined ? { authMethod: input.authMethod } : {}),
      ...(input.authConfig !== undefined
        ? { authConfig: input.authConfig as object }
        : {}),
      ...(input.defaultTransportConfig !== undefined
        ? { defaultTransportConfig: toJsonRecord(input.defaultTransportConfig) as object }
        : {}),
      ...(input.iconUrl !== undefined ? { iconUrl: input.iconUrl } : {}),
      ...(input.vendor !== undefined ? { vendor: input.vendor } : {}),
      ...(input.sourceUrl !== undefined ? { sourceUrl: input.sourceUrl } : {}),
      ...(input.signature !== undefined ? { signature: input.signature } : {}),
      ...(input.status !== undefined ? { status: input.status } : {}),
    },
  })
}

export const deleteCatalogEntry = async (
  prisma: PrismaClient,
  organizationId: string,
  id: string,
): Promise<boolean> => {
  const existing = await getCatalogEntry(prisma, organizationId, id)
  if (!existing) return false
  await prisma.mcpCatalogEntry.delete({ where: { id } })
  return true
}
