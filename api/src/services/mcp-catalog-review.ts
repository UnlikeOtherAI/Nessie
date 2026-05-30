import type { PrismaClient } from '@prisma/client'
import type { AuthorizedActionContext } from '@nessie/schemas'

import {
  canManageEntry,
  getAccessibleCatalogEntry,
  isOwnerRole,
  isUniqueViolation,
  McpCatalogError,
  MCP_CATALOG_ERROR_CODES,
  type McpCatalogEntryRow,
} from './mcp-catalog.js'

/**
 * Public-store review flow for the MCP App Store.
 * Spec: `docs/plans/2026-05-30-mcp-store-publishing-approval.md`.
 *
 * A connector reaches the shared store by being submitted for review by its
 * owner (`draft`/`rejected` → `pending_approval`, visibility flips to `public`)
 * and then approved by a superuser (the `owner` role) → `published`. Rejection
 * reverts the entry to a `private` `rejected` draft so the owner keeps using it
 * personally and can edit + resubmit; reverting also frees the public name.
 */

const requireSuperuser = (actorContext: AuthorizedActionContext): void => {
  if (!isOwnerRole(actorContext)) {
    throw new McpCatalogError(
      MCP_CATALOG_ERROR_CODES.FORBIDDEN,
      'Only a superuser can review public connector submissions',
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
  if (!canManageEntry(actorContext, existing)) {
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
 * Superuser approves a pending submission → `published` in the public store.
 * Atomic on `status === 'pending_approval'` so a double-approve is a no-op.
 */
export const approveSubmission = async (
  prisma: PrismaClient,
  actorContext: AuthorizedActionContext,
  id: string,
): Promise<McpCatalogEntryRow | null> => {
  requireSuperuser(actorContext)
  const existing = await getAccessibleCatalogEntry(prisma, actorContext, id)
  if (!existing) return null
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
 * owner can revise and resubmit.
 */
export const rejectSubmission = async (
  prisma: PrismaClient,
  actorContext: AuthorizedActionContext,
  id: string,
  reason: string,
): Promise<McpCatalogEntryRow | null> => {
  requireSuperuser(actorContext)
  const existing = await getAccessibleCatalogEntry(prisma, actorContext, id)
  if (!existing) return null
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
