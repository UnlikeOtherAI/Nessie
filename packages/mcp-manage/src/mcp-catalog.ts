import type { PrismaClient } from '@prisma/client'
import {
  McpServerAuthConfigSchema,
  ORGANIZATION_ADMIN_ROLES,
  type AuthorizedActionContext,
  type McpCatalogAuthMethod,
  type McpCatalogProtocol,
  type McpCatalogStatus,
  type McpCatalogVisibility,
  type McpServerAuthConfig,
} from '@nessie/schemas'
import { MCP_CATALOG_ERROR_CODES, McpCatalogError } from './mcp-catalog-errors.js'
import {
  assertCatalogSecurity,
  isUniqueViolation,
  toJsonRecord,
} from './mcp-catalog-guards.js'
import { catalogTenancyWhere } from './mcp-catalog-visibility.js'
import { assertCatalogLifecycleIsUserManaged } from './managed-products.js'

// Re-exported so the package's public surface is unchanged by the split.
export { MCP_CATALOG_ERROR_CODES, McpCatalogError }
export { isUniqueViolation }

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
  locked: boolean
  lockedAt: Date | null
  lockedBy: string | null
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

/**
 * DB-authoritative admin check for contexts whose JWT roles may be absent or
 * stale (the personal assistant derives its acting-user context in the
 * worker). Falls back to the membership row.
 */
export const isAdminUser = async (
  prisma: PrismaClient,
  organizationId: string,
  userId: string,
): Promise<boolean> => {
  const membership = await prisma.organizationMember.findUnique({
    where: { organizationId_userId: { organizationId, userId } },
    select: { role: true, deactivatedAt: true },
  })
  if (!membership || membership.deactivatedAt) return false
  return ORGANIZATION_ADMIN_ROLES.has(membership.role)
}

/**
 * The instance-wide administrator. `User.superAdmin` is a flag on the user row,
 * deliberately not an organisation membership and not a session claim, so it is
 * read from the database exactly like `isAdminUser` above.
 *
 * This exists because "owner of the shared organisation" used to be the only
 * thing in Nessie resembling an instance administrator. With one Organization
 * per UOA organisation an org owner administers exactly one tenant, so the two
 * catalog decisions that are genuinely instance-wide — mutating an
 * `organizationId: null` row, and publishing into the shared store — name this
 * role instead of inheriting one from the old flattened model.
 */
export const isSuperAdminUser = async (
  prisma: PrismaClient,
  actorContext: AuthorizedActionContext,
): Promise<boolean> => {
  if (actorContext.actor.actorType !== 'user') return false
  const user = await prisma.user.findUnique({
    where: { id: actorContext.actor.actorId },
    select: { superAdmin: true },
  })
  return user?.superAdmin ?? false
}

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
  const entry = await prisma.mcpCatalogEntry.findFirst({
    where: { id, ...catalogTenancyWhere(actorContext) },
  })
  if (!entry) return null
  const visible =
    isOwnerRole(actorContext)
    || entry.ownerUserId === actorContext.actor.actorId
    || (entry.visibility === 'public' && entry.status === 'published')
  return visible ? entry : null
}

/**
 * True when `actorContext` may mutate the entry: its author, an org owner
 * acting on an entry inside their own tenant, or the instance super-admin on an
 * instance-global row.
 *
 * An org owner is NOT a superuser, so ownership of one tenant must never confer
 * management of another tenant's connector — those rows hold plaintext OAuth
 * client secrets. The `organizationId: null` rows are the instance's own
 * first-party/integration entries, readable by *every* tenant
 * (`catalogTenancyWhere`), so letting any tenant's owner rewrite their
 * transport URL or auth config is the same cross-tenant escalation in a
 * different shape. That arm used to lean on `organizationId: null` meaning "the
 * one shared org's rows"; under per-UOA-org tenancy it names `User.superAdmin`
 * — the real instance-wide administrator — instead. `assertCatalogLifecycleIsUserManaged`
 * still fences the managed product slugs on top of this.
 */
export const canManageEntry = async (
  prisma: PrismaClient,
  actorContext: AuthorizedActionContext,
  entry: McpCatalogEntryRow,
): Promise<boolean> => {
  if (entry.ownerUserId !== null && entry.ownerUserId === actorContext.actor.actorId) {
    return true
  }
  if (!isOwnerRole(actorContext)) return false
  if (entry.organizationId === actorContext.tenant.organizationId) return true
  if (entry.organizationId !== null) return false
  return isSuperAdminUser(prisma, actorContext)
}

const requireManageable = async (
  prisma: PrismaClient,
  actorContext: AuthorizedActionContext,
  id: string,
): Promise<McpCatalogEntryRow | null> => {
  const entry = await getAccessibleCatalogEntry(prisma, actorContext, id)
  if (!entry) return null
  if (!(await canManageEntry(prisma, actorContext, entry))) {
    throw new McpCatalogError(
      MCP_CATALOG_ERROR_CODES.FORBIDDEN,
      'You do not have permission to modify this catalog entry',
    )
  }
  await assertCatalogLifecycleIsUserManaged(prisma, id)
  return entry
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
 * Retire a published entry: `deprecated` on the connector lifecycle, `hidden`
 * on the store. Non-destructive — existing `McpServerInstance` rows pointing at
 * this catalog id keep working — but it is no longer offered anywhere: not in
 * the new-install pickers, and not as an app card. Idempotent.
 *
 * Writing the store state is the fix, rather than teaching `storeCatalogWhere`
 * to filter `status: 'deprecated'`, for three reasons. The store migration
 * already maps `deprecated` → `hidden`, so writing it keeps rows retired after
 * this change identical to rows retired before it, instead of leaving two
 * populations that differ in the column the store actually reads. The store
 * asks one question — what did a human decide about listing this? — and a
 * second lifecycle column in that predicate is precisely the drift the "one
 * catalogue, two faces" rule forbids: the write path records the decision, the
 * read path does not re-derive it. And it leaves `approved` admitted
 * unconditionally, which a top-level status filter would silently qualify.
 *
 * Deprecation had previously moved `status` alone, so the store's owner arm
 * (`curated` + caller-owned) kept listing a retired connector to its owner with
 * a live Connect action — an install path for something just withdrawn.
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
    data: { status: 'deprecated', moderationState: 'hidden' },
  })
}
