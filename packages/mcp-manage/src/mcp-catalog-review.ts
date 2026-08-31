import type { PrismaClient } from '@prisma/client'
import type { AuthorizedActionContext } from '@nessie/schemas'

import {
  canManageEntry,
  getAccessibleCatalogEntry,
  isSuperAdminUser,
  isUniqueViolation,
  McpCatalogError,
  MCP_CATALOG_ERROR_CODES,
  type McpCatalogEntryRow,
} from './mcp-catalog.js'
import { assertCatalogLifecycleIsUserManaged } from './managed-products.js'

/**
 * Public-store review flow for the Apps catalogue.
 * Spec: `docs/plans/2026-05-30-mcp-store-publishing-approval.md`.
 *
 * A connector reaches the shared store by being submitted for review by its
 * owner (`draft`/`rejected` → `pending_approval`, visibility flips to `public`)
 * and then approved by the instance super-admin → `published`. Rejection
 * reverts the entry to a `private` `rejected` draft so the owner keeps using it
 * personally and can edit + resubmit; reverting also frees the public name.
 *
 * "Superuser" here has always meant the person who administers this Nessie
 * instance — publishing puts a connector in front of every organisation on it.
 * The check used to be the `owner` role because under the old single shared
 * organisation that was the closest thing available. It is now `User.superAdmin`,
 * the role that actually names instance administration; an org owner reviewing
 * submissions on behalf of every other tenant was never the intent.
 *
 * **A review outcome is written to `moderationState`, not left to be inferred.**
 * The App Store (`app-store-visibility.ts`) lists by moderation state, so a
 * review that only moved `visibility`/`status` left the store's copy of the
 * decision stale: an approved entry appeared only by accident of the curation
 * rule's "public + published" arm, and a *rejected* one kept the `curated` state
 * the store migration had backfilled — still an ordinary app card to its owner,
 * claiming a curation decision nobody made. Approval writes `approved`;
 * rejection writes `hidden`, the store's word for a deliberate removal.
 * Submission writes nothing: a request is not a decision, and laundering the
 * state on submit would let an owner re-list an entry a reviewer had removed.
 */

const requireSuperAdmin = async (
  prisma: PrismaClient,
  actorContext: AuthorizedActionContext,
): Promise<void> => {
  if (!(await isSuperAdminUser(prisma, actorContext))) {
    throw new McpCatalogError(
      MCP_CATALOG_ERROR_CODES.FORBIDDEN,
      'Only an instance super-admin can review public connector submissions',
    )
  }
}

/**
 * Submit a connector for inclusion in the public store. The owner (or a
 * superuser) flips it to a `public` `pending_approval` entry. The public-name
 * partial unique index means submission fails if the name is already taken in
 * the store.
 */
export const submitForReview = async (
  prisma: PrismaClient,
  actorContext: AuthorizedActionContext,
  id: string,
): Promise<McpCatalogEntryRow | null> => {
  const existing = await getAccessibleCatalogEntry(prisma, actorContext, id)
  if (!existing) return null
  await assertCatalogLifecycleIsUserManaged(prisma, id)
  if (!(await canManageEntry(prisma, actorContext, existing))) {
    throw new McpCatalogError(
      MCP_CATALOG_ERROR_CODES.FORBIDDEN,
      'You do not have permission to submit this catalog entry',
    )
  }
  if (existing.status === 'pending_approval' && existing.visibility === 'public') {
    return existing
  }
  if (existing.status !== 'draft' && existing.status !== 'rejected') {
    throw new McpCatalogError(
      MCP_CATALOG_ERROR_CODES.INVALID_TRANSITION,
      `Catalog entry ${id} cannot be submitted from ${existing.status}`,
    )
  }

  try {
    return await prisma.mcpCatalogEntry.update({
      where: { id },
      data: {
        visibility: 'public',
        status: 'pending_approval',
        submittedAt: new Date(),
        reviewedAt: null,
        reviewedBy: null,
        rejectionReason: null,
      },
    })
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new McpCatalogError(
        MCP_CATALOG_ERROR_CODES.DUPLICATE_NAME,
        `A public connector named "${existing.name}" already exists in the store`,
      )
    }
    throw error
  }
}

/**
 * Superuser approves a pending submission → `published` in the public store,
 * and `moderationState: 'approved'` so the App Store lists it *because* of the
 * decision rather than as a side effect of it now being public + published.
 * Atomic on `status === 'pending_approval'` so a double-approve is a no-op.
 */
export const approveSubmission = async (
  prisma: PrismaClient,
  actorContext: AuthorizedActionContext,
  id: string,
): Promise<McpCatalogEntryRow | null> => {
  await requireSuperAdmin(prisma, actorContext)
  const existing = await getAccessibleCatalogEntry(prisma, actorContext, id)
  if (!existing) return null
  await assertCatalogLifecycleIsUserManaged(prisma, id)
  if (existing.status === 'published') return existing
  if (existing.status !== 'pending_approval') {
    throw new McpCatalogError(
      MCP_CATALOG_ERROR_CODES.INVALID_TRANSITION,
      `Catalog entry ${id} is not awaiting approval (status ${existing.status})`,
    )
  }

  const { count } = await prisma.mcpCatalogEntry.updateMany({
    where: { id, status: 'pending_approval' },
    data: {
      status: 'published',
      visibility: 'public',
      moderationState: 'approved',
      reviewedAt: new Date(),
      reviewedBy: actorContext.actor.actorId,
      rejectionReason: null,
    },
  })
  if (count === 0) {
    const current = await getAccessibleCatalogEntry(prisma, actorContext, id)
    if (current?.status === 'published') return current
    throw new McpCatalogError(
      MCP_CATALOG_ERROR_CODES.INVALID_TRANSITION,
      `Catalog entry ${id} is no longer awaiting approval`,
    )
  }
  return getAccessibleCatalogEntry(prisma, actorContext, id)
}

/**
 * Superuser rejects a pending submission. The entry reverts to a `private`
 * `rejected` draft (freeing the public name) with the reason recorded so the
 * owner can revise and resubmit, and leaves the App Store as `hidden`.
 *
 * The owner does not lose the connector — it is still theirs to install, and
 * the management API records the rejection reason and accepts resubmission.
 * What they lose is the app card, which had been telling them a reviewer had
 * curated something a reviewer had just refused.
 */
export const rejectSubmission = async (
  prisma: PrismaClient,
  actorContext: AuthorizedActionContext,
  id: string,
  reason: string,
): Promise<McpCatalogEntryRow | null> => {
  await requireSuperAdmin(prisma, actorContext)
  const existing = await getAccessibleCatalogEntry(prisma, actorContext, id)
  if (!existing) return null
  await assertCatalogLifecycleIsUserManaged(prisma, id)
  if (existing.status !== 'pending_approval') {
    throw new McpCatalogError(
      MCP_CATALOG_ERROR_CODES.INVALID_TRANSITION,
      `Catalog entry ${id} is not awaiting approval (status ${existing.status})`,
    )
  }

  // Atomic on `status === 'pending_approval'` (mirrors approveSubmission) so a
  // concurrent approve+reject can't both win and clobber a published entry.
  const { count } = await prisma.mcpCatalogEntry.updateMany({
    where: { id, status: 'pending_approval' },
    data: {
      visibility: 'private',
      status: 'rejected',
      moderationState: 'hidden',
      reviewedAt: new Date(),
      reviewedBy: actorContext.actor.actorId,
      rejectionReason: reason,
    },
  })
  if (count === 0) {
    throw new McpCatalogError(
      MCP_CATALOG_ERROR_CODES.INVALID_TRANSITION,
      `Catalog entry ${id} is no longer awaiting approval`,
    )
  }
  return getAccessibleCatalogEntry(prisma, actorContext, id)
}
