import { Prisma, type PrismaClient } from '@prisma/client'

import { pageSharedWithUser, type KnowledgePageShareAccessLevel, type SpaceViewer } from './access.js'

/**
 * Person-to-person page shares: the data layer under
 * `api/src/routes/knowledge-shares.ts`.
 *
 * A share is one row granting one person access to one page — and, when that
 * page is a folder, to everything under it, resolved by the ancestor walk in
 * `access.ts` rather than by copying a row onto each descendant. Revocation is
 * a hard delete: the audit trail is the history, so a tombstone would only be a
 * second place for the same fact to be wrong.
 *
 * Nothing here decides *who may* share; that is the route's job, because the
 * rule ("only pages in the sharer's own personal space") is about the space and
 * the actor, not about the share row. Keeping the check out of this file stops
 * a second, weaker copy of it appearing beside the real one.
 *
 * Contract: docs/plans/2026-09-16-documents-finder-ui/data-and-api.md §2, §4.
 */

/** The share as the API serialises it; timestamps are ISO strings. */
export type KnowledgePageShareRow = {
  id: string
  pageId: string
  spaceId: string
  granteeUserId: string
  grantedByUserId: string
  access: KnowledgePageShareAccessLevel
  createdAt: string
  updatedAt: string
}

type ShareRecord = {
  id: string
  pageId: string
  spaceId: string
  granteeUserId: string
  grantedByUserId: string
  access: string
  createdAt: Date
  updatedAt: Date
}

const shareSelect = {
  id: true,
  pageId: true,
  spaceId: true,
  granteeUserId: true,
  grantedByUserId: true,
  access: true,
  createdAt: true,
  updatedAt: true,
} as const

export const mapPageShare = (row: ShareRecord): KnowledgePageShareRow => ({
  id: row.id,
  pageId: row.pageId,
  spaceId: row.spaceId,
  granteeUserId: row.granteeUserId,
  grantedByUserId: row.grantedByUserId,
  access: row.access as KnowledgePageShareAccessLevel,
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
})

/**
 * Whether this viewer reaches this page through a share, at or above `minimum`.
 * The one predicate every API access arm asks, so the preconditions live here
 * once instead of beside each caller.
 *
 * It answers for *one page id*. That is what keeps an `edit` share from
 * becoming write access to the owner's space: nothing here consults
 * `canWriteSpace`, and nothing that consults it need consider shares.
 *
 * `writeRestricted` on the space is deliberately not considered. An edit share
 * is exactly the explicit per-person grant that flag reserves writing for,
 * narrowed further to a single page, so honouring the share honours the flag
 * rather than bypassing it.
 */
export const viewerHoldsPageShare = async (
  prisma: PrismaClient,
  input: {
    organizationId: string
    actorType: 'user' | 'agent' | 'service'
    page: { id: string; status: string; deletedAt: string | null }
    viewer: SpaceViewer
    minimum: KnowledgePageShareAccessLevel
  },
): Promise<boolean> => {
  // Agents never hold shares, and a viewer without a live organization proof
  // holds nothing at all — a share can only narrow an entitlement, never stand
  // in for one.
  if (input.actorType !== 'user') return false
  if (input.viewer.baseEntitled === false) return false
  const userId = input.viewer.userId
  if (userId === null) return false
  // Archiving hides a shared page from its recipients: this check runs before
  // the share lookup, so the owner's own delete ends every grantee's access
  // without anybody having to revoke a row.
  if (input.page.status === 'archived' || input.page.deletedAt !== null) return false
  return pageSharedWithUser(prisma, {
    organizationId: input.organizationId,
    pageId: input.page.id,
    userId,
    minimum: input.minimum,
  })
}

/** Every share on one page, oldest first, so the dialog's list is stable. */
export const listPageShares = async (
  prisma: PrismaClient,
  input: { organizationId: string; pageId: string },
): Promise<KnowledgePageShareRow[]> => {
  const rows = await prisma.knowledgePageShare.findMany({
    where: { organizationId: input.organizationId, pageId: input.pageId },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: shareSelect,
  })
  return rows.map(mapPageShare)
}

export const findPageShare = async (
  prisma: PrismaClient,
  input: { organizationId: string; pageId: string; granteeUserId: string },
): Promise<KnowledgePageShareRow | null> => {
  const row = await prisma.knowledgePageShare.findFirst({
    where: {
      organizationId: input.organizationId,
      pageId: input.pageId,
      granteeUserId: input.granteeUserId,
    },
    select: shareSelect,
  })
  return row ? mapPageShare(row) : null
}

/**
 * Creating a share is idempotent and is also the change-level path: an existing
 * row comes back with the body's level applied. `previousAccess` is what the
 * route needs to choose between the `kb.page.shared` and
 * `kb.page.share_changed` audit actions — a re-share at the same level is
 * neither a new grant nor a change, and says so by reporting `created: false`
 * with an unchanged level.
 */
export const upsertPageShare = async (
  prisma: PrismaClient,
  input: {
    organizationId: string
    pageId: string
    spaceId: string
    granteeUserId: string
    grantedByUserId: string
    access: KnowledgePageShareAccessLevel
  },
): Promise<{
  share: KnowledgePageShareRow
  created: boolean
  previousAccess: KnowledgePageShareAccessLevel | null
}> => {
  const existing = await findPageShare(prisma, input)
  if (existing) {
    if (existing.access === input.access) {
      return { share: existing, created: false, previousAccess: existing.access }
    }
    const updated = await prisma.knowledgePageShare.update({
      where: { id: existing.id },
      data: { access: input.access },
      select: shareSelect,
    })
    return { share: mapPageShare(updated), created: false, previousAccess: existing.access }
  }
  const created = await prisma.knowledgePageShare.create({
    data: {
      organizationId: input.organizationId,
      pageId: input.pageId,
      spaceId: input.spaceId,
      granteeUserId: input.granteeUserId,
      grantedByUserId: input.grantedByUserId,
      access: input.access,
    },
    select: shareSelect,
  })
  return { share: mapPageShare(created), created: true, previousAccess: null }
}

export const setPageShareAccess = async (
  prisma: PrismaClient,
  input: {
    organizationId: string
    pageId: string
    granteeUserId: string
    access: KnowledgePageShareAccessLevel
  },
): Promise<{
  share: KnowledgePageShareRow
  previousAccess: KnowledgePageShareAccessLevel
} | null> => {
  const existing = await findPageShare(prisma, input)
  if (!existing) return null
  if (existing.access === input.access) {
    return { share: existing, previousAccess: existing.access }
  }
  const updated = await prisma.knowledgePageShare.update({
    where: { id: existing.id },
    data: { access: input.access },
    select: shareSelect,
  })
  return { share: mapPageShare(updated), previousAccess: existing.access }
}

export const removePageShare = async (
  prisma: PrismaClient,
  input: { organizationId: string; pageId: string; granteeUserId: string },
): Promise<KnowledgePageShareRow | null> => {
  const existing = await findPageShare(prisma, input)
  if (!existing) return null
  // Delete by id under the same organization fence the read used, so a
  // concurrent revoke resolves to "already gone" rather than to a delete that
  // could ever address another tenant's row.
  const deleted = await prisma.knowledgePageShare.deleteMany({
    where: { id: existing.id, organizationId: input.organizationId },
  })
  return deleted.count > 0 ? existing : null
}

/** How many people a page is shared with; the row's `faUserGroup` glyph. */
export const countPageShares = async (
  prisma: PrismaClient,
  input: { organizationId: string; pageId: string },
): Promise<number> =>
  prisma.knowledgePageShare.count({
    where: { organizationId: input.organizationId, pageId: input.pageId },
  })

export type GranteeShareRow = {
  id: string
  pageId: string
  spaceId: string
  granteeUserId: string
  grantedByUserId: string
  access: KnowledgePageShareAccessLevel
  createdAt: Date
}

/**
 * The Shared-with-me listing: shares to one person, newest share first, keyset
 * paged on (created_at, id). Archived and deleted pages drop out here rather
 * than in the caller, because a grantee whose page the owner archived must stop
 * seeing it in the same read that stops opening it.
 */
export const listSharesForGrantee = async (
  prisma: PrismaClient,
  input: {
    organizationId: string
    userId: string
    cursor: { createdAt: Date; id: string } | null
    take: number
  },
): Promise<GranteeShareRow[]> => {
  const rows = await prisma.knowledgePageShare.findMany({
    where: {
      organizationId: input.organizationId,
      granteeUserId: input.userId,
      page: {
        deletedAt: null,
        status: { not: 'archived' },
        space: { deletedAt: null },
      },
      ...(input.cursor
        ? {
            OR: [
              { createdAt: { lt: input.cursor.createdAt } },
              { createdAt: input.cursor.createdAt, id: { lt: input.cursor.id } },
            ],
          }
        : {}),
    },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: input.take,
    select: {
      id: true,
      pageId: true,
      spaceId: true,
      granteeUserId: true,
      grantedByUserId: true,
      access: true,
      createdAt: true,
    },
  })
  return rows.map((row) => ({ ...row, access: row.access as KnowledgePageShareAccessLevel }))
}

/**
 * The ids of a shared folder's subtree, the folder itself first.
 *
 * The cap is reported rather than silently applied: a listing that quietly
 * stops at 10 000 rows looks exactly like a folder that ends there.
 */
export const sharedSubtreePageIds = async (
  prisma: PrismaClient,
  input: { organizationId: string; rootPageId: string; limit?: number },
): Promise<{ pageIds: string[]; truncated: boolean }> => {
  const limit = input.limit ?? 10_000
  const rows = await prisma.$queryRaw<{ id: string }[]>(Prisma.sql`
    WITH RECURSIVE subtree AS (
      SELECT id, 0 AS depth
        FROM knowledge_pages
       WHERE id = ${input.rootPageId}::uuid
         AND organization_id = ${input.organizationId}::uuid
         AND deleted_at IS NULL
      UNION ALL
      SELECT c.id, subtree.depth + 1
        FROM knowledge_pages c
        JOIN subtree ON c.parent_page_id = subtree.id
       WHERE subtree.depth < 64
         AND c.organization_id = ${input.organizationId}::uuid
         AND c.deleted_at IS NULL
    )
    SELECT id FROM subtree LIMIT ${limit + 1}
  `)
  return {
    pageIds: rows.slice(0, limit).map((row) => row.id),
    truncated: rows.length > limit,
  }
}

/**
 * Ancestors of each page, space root first and immediate parent last — the
 * order a breadcrumb reads in. One query for a whole listing: the Finder's home
 * line needs the path for every row, and a walk per row is a query per row.
 */
export const pageAncestorPaths = async (
  prisma: PrismaClient,
  input: { organizationId: string; pageIds: readonly string[] },
): Promise<Map<string, { id: string; title: string }[]>> => {
  const paths = new Map<string, { id: string; title: string }[]>()
  if (input.pageIds.length === 0) return paths
  const rows = await prisma.$queryRaw<{
    origin_id: string
    id: string
    title: string
    depth: number
  }[]>(Prisma.sql`
    WITH RECURSIVE chain AS (
      SELECT id AS origin_id, id, parent_page_id, title, 0 AS depth
        FROM knowledge_pages
       WHERE id IN (${Prisma.join(input.pageIds.map((id) => Prisma.sql`${id}::uuid`))})
         AND organization_id = ${input.organizationId}::uuid
         AND deleted_at IS NULL
      UNION ALL
      SELECT chain.origin_id, p.id, p.parent_page_id, p.title, chain.depth + 1
        FROM knowledge_pages p
        JOIN chain ON p.id = chain.parent_page_id
       WHERE chain.depth < 64
         AND p.organization_id = ${input.organizationId}::uuid
         AND p.deleted_at IS NULL
    )
    SELECT origin_id, id, title, depth
      FROM chain
     WHERE depth > 0
     ORDER BY origin_id, depth DESC
  `)
  for (const row of rows) {
    const path = paths.get(row.origin_id) ?? []
    path.push({ id: row.id, title: row.title })
    paths.set(row.origin_id, path)
  }
  for (const pageId of input.pageIds) {
    if (!paths.has(pageId)) paths.set(pageId, [])
  }
  return paths
}
