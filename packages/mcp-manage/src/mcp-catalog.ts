import type { PrismaClient } from '@prisma/client'
import {
  McpServerAuthConfigSchema,
  type AuthorizedActionContext,
  type McpCatalogAuthMethod,
  type McpCatalogProtocol,
  type McpCatalogStatus,
  type McpCatalogVisibility,
  type McpServerAuthConfig,
} from '@nessie/schemas'
import {
  McpSecurityError,
  assertMcpAuthUrlsSafe,
  assertUserAuthoredMcpTransportSafe,
} from './mcp-security.js'

/**
 * MCP App Store catalog service.
 *
 * Spec: `docs/external-tool-integration.md` §2,
 * `docs/plans/2026-05-30-mcp-store-publishing-approval.md`.
 *
 * `McpCatalogEntry` rows are installable MCP-server definitions. Every entry is
 * created `private` + `draft`, owned by its author (`ownerUserId`):
 *
 * - A `private` connector is visible only to its owner, who self-publishes it
 *   (`draft` → `published`) and installs it without review.
 * - A `public` connector is listed in the shared store. It gets there by being
 *   submitted for review (`draft` → `pending_approval`, visibility flips to
 *   `public`) and approved by a superuser (the `owner` role) → `published`.
 *
 * The submit/approve/reject transitions live in `mcp-catalog-review.ts`; this
 * file owns CRUD, listing, the access predicate, and the private self-publish /
 * deprecate transitions.
 */

export const MCP_CATALOG_ERROR_CODES = {
  NOT_FOUND: 'MCP_CATALOG_ENTRY_NOT_FOUND',
  AUTH_CONFIG_INVALID: 'MCP_CATALOG_AUTH_CONFIG_INVALID',
  AUTH_METHOD_MISMATCH: 'MCP_CATALOG_AUTH_METHOD_MISMATCH',
  TRANSPORT_CONFIG_INVALID: 'MCP_CATALOG_TRANSPORT_CONFIG_INVALID',
  DUPLICATE_NAME: 'MCP_CATALOG_ENTRY_DUPLICATE_NAME',
  INVALID_TRANSITION: 'MCP_CATALOG_ENTRY_INVALID_TRANSITION',
  FORBIDDEN: 'MCP_CATALOG_ENTRY_FORBIDDEN',
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
  visibility: McpCatalogVisibility
  ownerUserId: string | null
  submittedAt: Date | null
  reviewedAt: Date | null
  reviewedBy: string | null
  rejectionReason: string | null
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
}>

/** Which slice of the catalog a list request wants. */
export type CatalogView = 'store' | 'mine' | 'queue' | 'all'

export const isOwnerRole = (actorContext: AuthorizedActionContext): boolean =>
  actorContext.actor.roles?.includes('owner') ?? false

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

export const isUniqueViolation = (error: unknown): boolean =>
  typeof error === 'object'
  && error !== null
  && 'code' in error
  && (error as { code?: unknown }).code === 'P2002'

const duplicateNameError = (name: string): McpCatalogError =>
  new McpCatalogError(
    MCP_CATALOG_ERROR_CODES.DUPLICATE_NAME,
    `An MCP catalog entry named "${name}" already exists in this scope`,
  )

const transportConfigError = (message: string): McpCatalogError =>
  new McpCatalogError(MCP_CATALOG_ERROR_CODES.TRANSPORT_CONFIG_INVALID, message)

const mapSecurityError = (error: unknown): never => {
  if (error instanceof McpSecurityError) {
    throw transportConfigError(error.message)
  }
  throw error
}

const assertCatalogProtocolSafe = (protocol: McpCatalogProtocol): void => {
  if (protocol === 'stdio') {
    throw transportConfigError(
      'MCP stdio transport is disabled for user-authored connectors',
    )
  }
}

const assertCatalogSecurity = async (
  input: {
    authConfig?: McpServerAuthConfig
    defaultTransportConfig?: unknown
    protocol?: McpCatalogProtocol
  },
): Promise<void> => {
  if (input.protocol) assertCatalogProtocolSafe(input.protocol)
  try {
    if (input.authConfig) {
      await assertMcpAuthUrlsSafe(input.authConfig)
    }
    await assertUserAuthoredMcpTransportSafe(input.defaultTransportConfig)
  } catch (error) {
    mapSecurityError(error)
  }
}

/**
 * Build the `where` clause that scopes a listing to what `actorContext` may
 * see. Superusers (`owner` role) see everything; everyone else sees the public
 * store plus their own entries.
 */
const listWhere = (
  actorContext: AuthorizedActionContext,
  view: CatalogView,
): Record<string, unknown> => {
  const ownerUserId = actorContext.actor.actorId
  switch (view) {
    case 'store':
      return { visibility: 'public', status: 'published' }
    case 'mine':
      return { ownerUserId }
    case 'queue':
      return { status: 'pending_approval', visibility: 'public' }
    case 'all':
      return {}
  }
}

export const listCatalogEntries = async (
  prisma: PrismaClient,
  actorContext: AuthorizedActionContext,
  filters: { view?: CatalogView; status?: McpCatalogStatus } = {},
): Promise<McpCatalogEntryRow[]> => {
  const view = filters.view ?? 'store'
  const where = listWhere(actorContext, view)
  // A caller-supplied status sub-filter only narrows the management views
  // ('mine', 'all'). 'store' and 'queue' pin status (published /
  // pending_approval) so a status param can never widen them — otherwise
  // `?view=store&status=pending_approval` would leak the public review queue.
  if (filters.status && (view === 'mine' || view === 'all')) {
    where.status = filters.status
  }
  return prisma.mcpCatalogEntry.findMany({
    where,
    orderBy: [{ status: 'asc' }, { label: 'asc' }],
  })
}

/**
 * Org-scoped by-id read for internal, post-install operations (OAuth handshake,
 * instance probe/health) where access was already established at install time
 * and the organization is trusted. Matches system-wide (`null` org) and
 * same-org entries. User-facing access goes through `getAccessibleCatalogEntry`.
 */
export const getCatalogEntry = async (
  prisma: PrismaClient,
  organizationId: string,
  id: string,
): Promise<McpCatalogEntryRow | null> => {
  return prisma.mcpCatalogEntry.findFirst({
    where: { id, OR: [{ organizationId: null }, { organizationId }] },
  })
}

/**
 * Fetch an entry only if `actorContext` is allowed to see it: the public store
 * (published), the actor's own entries (any status), or anything when the actor
 * is a superuser. Used by the detail route, install, and the review service.
 */
export const getAccessibleCatalogEntry = async (
  prisma: PrismaClient,
  actorContext: AuthorizedActionContext,
  id: string,
): Promise<McpCatalogEntryRow | null> => {
  if (isOwnerRole(actorContext)) {
    return prisma.mcpCatalogEntry.findFirst({ where: { id } })
  }
  return prisma.mcpCatalogEntry.findFirst({
    where: {
      id,
      OR: [
        { visibility: 'public', status: 'published' },
        { ownerUserId: actorContext.actor.actorId },
      ],
    },
  })
}

/**
 * True when `actorContext` may mutate the entry: its owner, or a superuser.
 */
export const canManageEntry = (
  actorContext: AuthorizedActionContext,
  entry: McpCatalogEntryRow,
): boolean =>
  isOwnerRole(actorContext)
  || (entry.ownerUserId !== null && entry.ownerUserId === actorContext.actor.actorId)

const requireManageable = async (
  prisma: PrismaClient,
  actorContext: AuthorizedActionContext,
  id: string,
): Promise<McpCatalogEntryRow | null> => {
  const entry = await getAccessibleCatalogEntry(prisma, actorContext, id)
  if (!entry) return null
  if (!canManageEntry(actorContext, entry)) {
    throw new McpCatalogError(
      MCP_CATALOG_ERROR_CODES.FORBIDDEN,
      'You do not have permission to modify this catalog entry',
    )
  }
  return entry
}

export const createCatalogEntry = async (
  prisma: PrismaClient,
  actorContext: AuthorizedActionContext,
  input: CreateCatalogEntryInput,
): Promise<McpCatalogEntryRow> => {
  const authConfig = ensureAuthConfigMatchesMethod(input.authMethod, input.authConfig)
  await assertCatalogSecurity({
    authConfig,
    defaultTransportConfig: input.defaultTransportConfig,
    protocol: input.protocol,
  })

  try {
    return await prisma.mcpCatalogEntry.create({
      data: {
        organizationId: actorContext.tenant.organizationId,
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
        visibility: 'private',
        ownerUserId: actorContext.actor.actorId,
        createdBy: actorContext.actor.actorId,
      },
    })
  } catch (error) {
    if (isUniqueViolation(error)) throw duplicateNameError(input.name)
    throw error
  }
}

export const updateCatalogEntry = async (
  prisma: PrismaClient,
  actorContext: AuthorizedActionContext,
  id: string,
  input: UpdateCatalogEntryInput,
): Promise<McpCatalogEntryRow | null> => {
  const existing = await requireManageable(prisma, actorContext, id)
  if (!existing) return null
  // Freeze the definition while it is under review so an approver can't be
  // shown one version and publish another. The owner must retract first.
  if (existing.status === 'pending_approval') {
    throw new McpCatalogError(
      MCP_CATALOG_ERROR_CODES.INVALID_TRANSITION,
      'Cannot edit a catalog entry while it is under review; retract the submission first',
    )
  }

  if (input.authConfig !== undefined || input.authMethod !== undefined) {
    const nextMethod = input.authMethod ?? existing.authMethod
    const nextConfig = input.authConfig ?? existing.authConfig
    const authConfig = ensureAuthConfigMatchesMethod(nextMethod, nextConfig)
    await assertCatalogSecurity({ authConfig })
  }
  await assertCatalogSecurity({
    defaultTransportConfig: input.defaultTransportConfig,
    protocol: input.protocol,
  })

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
    },
  })
}

export const deleteCatalogEntry = async (
  prisma: PrismaClient,
  actorContext: AuthorizedActionContext,
  id: string,
): Promise<boolean> => {
  const existing = await requireManageable(prisma, actorContext, id)
  if (!existing) return false
  await prisma.mcpCatalogEntry.delete({ where: { id } })
  return true
}

/**
 * Self-publish a `private` connector (`draft` → `published`) so its owner can
 * install it. Public connectors must instead go through the review flow
 * (`submitForReview` → superuser `approveSubmission`) and are rejected here.
 *
 * Concurrency: the transition is a single conditional `updateMany` keyed on
 * `status === 'draft'`, so two concurrent publishes race at the database and
 * exactly one wins; the loser re-reads to return a consistent answer.
 */
export const publishCatalogEntry = async (
  prisma: PrismaClient,
  actorContext: AuthorizedActionContext,
  id: string,
): Promise<McpCatalogEntryRow | null> => {
  const existing = await requireManageable(prisma, actorContext, id)
  if (!existing) return null
  if (existing.visibility === 'public') {
    throw new McpCatalogError(
      MCP_CATALOG_ERROR_CODES.INVALID_TRANSITION,
      `Catalog entry ${id} is public; use the review flow to publish it`,
    )
  }
  if (existing.status === 'published') return existing
  if (existing.status !== 'draft') {
    throw new McpCatalogError(
      MCP_CATALOG_ERROR_CODES.INVALID_TRANSITION,
      `Catalog entry ${id} cannot be published from ${existing.status}`,
    )
  }

  const { count } = await prisma.mcpCatalogEntry.updateMany({
    where: { id, status: 'draft', visibility: 'private' },
    data: { status: 'published' },
  })
  if (count === 0) {
    const current = await getAccessibleCatalogEntry(prisma, actorContext, id)
    if (!current) return null
    if (current.status === 'published') return current
    throw new McpCatalogError(
      MCP_CATALOG_ERROR_CODES.INVALID_TRANSITION,
      `Catalog entry ${id} is no longer in draft state`,
    )
  }
  return getAccessibleCatalogEntry(prisma, actorContext, id)
}

/**
 * Mark a published entry `deprecated`. Non-destructive: existing
 * `McpServerInstance` rows that point at this catalog id keep working; the flag
 * just hides the entry from new-install pickers. Idempotent.
 */
export const deprecateCatalogEntry = async (
  prisma: PrismaClient,
  actorContext: AuthorizedActionContext,
  id: string,
): Promise<McpCatalogEntryRow | null> => {
  const existing = await requireManageable(prisma, actorContext, id)
  if (!existing) return null
  if (existing.status === 'deprecated') return existing
  // Deprecation is a retirement of a live listing — only `published` entries
  // can be deprecated. Deprecating a draft/pending/rejected entry would create
  // a dead state and (for pending) silently bypass the rejection audit trail.
  if (existing.status !== 'published') {
    throw new McpCatalogError(
      MCP_CATALOG_ERROR_CODES.INVALID_TRANSITION,
      `Catalog entry ${id} cannot be deprecated from ${existing.status}`,
    )
  }
  return prisma.mcpCatalogEntry.update({
    where: { id },
    data: { status: 'deprecated' },
  })
}
