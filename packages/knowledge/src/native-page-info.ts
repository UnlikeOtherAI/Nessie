import { Prisma, type PrismaClient } from '@prisma/client'
import type {
  KnowledgeAccessSummary,
  KnowledgeItemInfo,
  KnowledgePageShareAccess,
} from '@nessie/schemas'

import type { SpaceViewer } from './access.js'
import { ancestorPathsFor, buildKnowledgeHome } from './native-latest-pages.js'
import { indexingStatesFor } from './native-indexing-status.js'
import { pageRowFactsFor } from './native-list-enrichment.js'
import type {
  KnowledgePageKind,
  KnowledgePageRecord,
  KnowledgePageStatus,
  KnowledgeSpaceRecord,
} from './types.js'

/**
 * Get Info — "how big is this, everything inside it included, and who can reach
 * it" — computed on read with one bounded recursive walk.
 *
 * There is no maintained `subtreeSizeBytes`: every upload, version, move and
 * archive would have to walk up and adjust it in the same transaction, and the
 * `StorageUsageEvent` ledger would then be a second truth beside it. The cost of
 * computing it is kept honest by the row cap instead: the walk stops at
 * `SUBTREE_ROW_CAP` rows and the answer says so, so a person reads "at least
 * this much" rather than waiting on an unbounded tree.
 *
 * Contract: docs/plans/2026-09-16-documents-finder-ui/data-and-api.md §5.
 */

/** The walk's hard bound. The row past it only sets `truncated`. */
export const SUBTREE_ROW_CAP = 10_000
const MAX_SUBTREE_DEPTH = 64

type SubtreeRow = {
  id: string
  kind: KnowledgePageKind
  status: KnowledgePageStatus
  publishedVersionId: string | null
  updatedAt: Date
  taskId: string | null
}

type SizeRow = {
  currentSizeBytes: bigint
  documentBodyBytes: bigint
  versionAttachmentBytes: bigint
  drawerAttachmentBytes: bigint
  attachmentVersions: bigint
  currentAttachmentVersions: bigint
}

export type PageInfoInput = {
  organizationId: string
  page: Pick<
    KnowledgePageRecord,
    'id' | 'kind' | 'title' | 'status' | 'taskId' | 'createdBy' | 'createdAt' | 'spaceId'
  >
  space: KnowledgeSpaceRecord
  viewer: SpaceViewer
  /** `canManageKnowledgeSpaceAccess` — it needs the actor context, which the route has. */
  canManageAccess: boolean
  /** Lower the walk's bound. Never raises it past `SUBTREE_ROW_CAP`. */
  rowCap?: number
}

export type SpaceInfoInput = {
  organizationId: string
  space: KnowledgeSpaceRecord
  viewer: SpaceViewer
  canManageAccess: boolean
  /** Lower the walk's bound. Never raises it past `SUBTREE_ROW_CAP`. */
  rowCap?: number
  /**
   * The space's exact usage from the `StorageUsageEvent` ledger. Passed in
   * because `FileService` lives in the API's composition root, and for a space
   * the ledger is exact and already paid for.
   */
  storageBytes: bigint
}

// One walk down `parent_page_id`, capped. The cap is applied to the whole walk
// rather than per level so a wide tree and a deep one cost the same ceiling.
const walkSubtree = async (
  prisma: PrismaClient,
  organizationId: string,
  root: { pageId: string } | { spaceId: string },
  rowCap = SUBTREE_ROW_CAP,
): Promise<{ rows: SubtreeRow[]; truncated: boolean }> => {
  const cap = Math.max(1, Math.min(Math.trunc(rowCap), SUBTREE_ROW_CAP))
  const seed = 'pageId' in root
    ? Prisma.sql`
        SELECT p.id, p.kind, p.status, p.published_version_id, p.updated_at, p.task_id, 0 AS depth
        FROM knowledge_pages p
        WHERE p.id = ${root.pageId}::uuid
          AND p.organization_id = ${organizationId}::uuid
          AND p.deleted_at IS NULL`
    : Prisma.sql`
        SELECT p.id, p.kind, p.status, p.published_version_id, p.updated_at, p.task_id, 0 AS depth
        FROM knowledge_pages p
        WHERE p.space_id = ${root.spaceId}::uuid
          AND p.organization_id = ${organizationId}::uuid
          AND p.parent_page_id IS NULL
          AND p.deleted_at IS NULL
          AND p.status <> 'archived'::"KnowledgePageStatus"`
  const rows = await prisma.$queryRaw<SubtreeRow[]>(Prisma.sql`
    WITH RECURSIVE subtree AS (
      ${seed}
      UNION ALL
      SELECT c.id, c.kind, c.status, c.published_version_id, c.updated_at, c.task_id, s.depth + 1
      FROM subtree s
      JOIN knowledge_pages c ON c.parent_page_id = s.id
      WHERE c.deleted_at IS NULL
        AND c.status <> 'archived'::"KnowledgePageStatus"
        AND s.depth < ${MAX_SUBTREE_DEPTH}
    )
    SELECT subtree.id,
           subtree.kind,
           subtree.status,
           subtree.published_version_id AS "publishedVersionId",
           subtree.updated_at AS "updatedAt",
           subtree.task_id AS "taskId"
    FROM subtree
    LIMIT ${cap + 1}
  `)
  return {
    rows: rows.slice(0, cap),
    truncated: rows.length > cap,
  }
}

const toBigInt = (value: bigint | number | string): bigint =>
  typeof value === 'bigint' ? value : BigInt(String(value))

// Every byte question the panel asks, as one aggregate over the walked ids:
// what a reader would get ("Size"), and what the quota charges ("On disk").
const sizesFor = async (prisma: PrismaClient, pageIds: string[]): Promise<SizeRow> => {
  if (pageIds.length === 0) {
    return {
      currentSizeBytes: 0n,
      documentBodyBytes: 0n,
      versionAttachmentBytes: 0n,
      drawerAttachmentBytes: 0n,
      attachmentVersions: 0n,
      currentAttachmentVersions: 0n,
    }
  }
  const rows = await prisma.$queryRaw<SizeRow[]>(Prisma.sql`
    WITH pages AS (
      SELECT p.id, p.published_version_id
      FROM knowledge_pages p
      WHERE p.id = ANY(${pageIds}::uuid[])
    ),
    current_version AS (
      SELECT DISTINCT ON (p.id)
             p.id AS page_id,
             v.id AS version_id,
             v.attachment_id,
             octet_length(coalesce(v.body, '')) AS body_bytes
      FROM pages p
      JOIN knowledge_page_versions v ON v.page_id = p.id
      ORDER BY p.id, (v.id = p.published_version_id) DESC, v.version_number DESC
    )
    SELECT
      (SELECT coalesce(sum(CASE WHEN cv.attachment_id IS NULL
                                THEN cv.body_bytes::bigint
                                ELSE coalesce(a.size_bytes, 0) END), 0)
         FROM current_version cv
         LEFT JOIN attachments a ON a.id = cv.attachment_id) AS "currentSizeBytes",
      (SELECT coalesce(sum(cv.body_bytes::bigint), 0)
         FROM current_version cv
        WHERE cv.attachment_id IS NULL) AS "documentBodyBytes",
      (SELECT coalesce(sum(a.size_bytes), 0)
         FROM knowledge_page_versions v
         JOIN attachments a ON a.id = v.attachment_id
        WHERE v.page_id = ANY(${pageIds}::uuid[])) AS "versionAttachmentBytes",
      (SELECT coalesce(sum(a.size_bytes), 0)
         FROM attachments a
        WHERE a.knowledge_page_id = ANY(${pageIds}::uuid[])) AS "drawerAttachmentBytes",
      (SELECT count(*)
         FROM knowledge_page_versions v
        WHERE v.page_id = ANY(${pageIds}::uuid[])
          AND v.attachment_id IS NOT NULL) AS "attachmentVersions",
      (SELECT count(*) FROM current_version cv WHERE cv.attachment_id IS NOT NULL)
        AS "currentAttachmentVersions"
  `)
  const row = rows[0]
  if (!row) throw new Error('Knowledge item size aggregate returned no row')
  // `sum()` over a bigint column is `numeric`, which the driver hands back as a
  // string however the row is typed — and `'1634' + '20'` is a plausible-looking
  // byte count that is wrong by three orders of magnitude. Normalise once, here.
  return {
    currentSizeBytes: toBigInt(row.currentSizeBytes),
    documentBodyBytes: toBigInt(row.documentBodyBytes),
    versionAttachmentBytes: toBigInt(row.versionAttachmentBytes),
    drawerAttachmentBytes: toBigInt(row.drawerAttachmentBytes),
    attachmentVersions: toBigInt(row.attachmentVersions),
    currentAttachmentVersions: toBigInt(row.currentAttachmentVersions),
  }
}

const isFlagged = (metadata: unknown, flag: string): boolean =>
  typeof metadata === 'object'
  && metadata !== null
  && !Array.isArray(metadata)
  && (metadata as Record<string, unknown>)[flag] === true

// The share that lets a grantee read a page: one on the page itself, or one on
// a folder above it (a folder share reaches everything under it).
const shareReachingPage = async (
  prisma: PrismaClient,
  pageIds: string[],
  userId: string,
): Promise<{ grantedByUserId: string; access: KnowledgePageShareAccess } | null> => {
  if (pageIds.length === 0) return null
  const share = await prisma.knowledgePageShare.findFirst({
    where: { pageId: { in: pageIds }, granteeUserId: userId },
    select: { grantedByUserId: true, access: true },
    orderBy: { createdAt: 'desc' },
  })
  return share ? { grantedByUserId: share.grantedByUserId, access: share.access } : null
}

const accessSummaryFor = async (
  prisma: PrismaClient,
  input: {
    space: KnowledgeSpaceRecord
    viewer: SpaceViewer
    canManageAccess: boolean
    // The page and its ancestors: where a share that reaches it could be.
    shareChainPageIds: string[]
    shareCount: number
  },
): Promise<KnowledgeAccessSummary> => {
  const { space, viewer, canManageAccess } = input
  if (isFlagged(space.metadata, 'personal')) {
    if (viewer.userId !== null && space.userId === viewer.userId) {
      return { mode: 'personal', shareCount: input.shareCount, canShare: true }
    }
    const share = viewer.userId
      ? await shareReachingPage(prisma, input.shareChainPageIds, viewer.userId)
      : null
    if (share) {
      return {
        mode: 'shared_to_me',
        sharedByUserId: share.grantedByUserId,
        access: share.access,
      }
    }
  }
  if (isFlagged(space.metadata, 'projectDocuments')) {
    const project = await prisma.project.findFirst({
      where: { id: space.projectId },
      select: { name: true, _count: { select: { members: true } } },
    })
    return {
      mode: 'project',
      projectId: space.projectId,
      projectName: project?.name ?? 'Project',
      memberCount: project?._count.members ?? 0,
    }
  }
  if (space.ownerAgentId) {
    const agent = await prisma.agent.findFirst({
      where: { id: space.ownerAgentId, organizationId: space.organizationId },
      select: { name: true },
    })
    return {
      mode: 'agent',
      agentId: space.ownerAgentId,
      agentName: agent?.name ?? 'Agent',
      memberUserCount: space.memberUserIds.length,
    }
  }
  return {
    mode: 'space',
    spaceId: space.id,
    spaceName: space.name,
    visibility: space.visibility ?? 'private',
    memberUserCount: space.memberUserIds.length,
    memberAgentCount: space.memberAgentIds.length,
    writeRestricted: space.writeRestricted,
    canManageAccess,
  }
}

const countsFor = (rows: readonly SubtreeRow[]): KnowledgeItemInfo['counts'] => {
  const counts = { folders: 0, documents: 0, files: 0 }
  for (const row of rows) {
    if (row.kind === 'folder') counts.folders += 1
    else if (row.kind === 'file') counts.files += 1
    else counts.documents += 1
  }
  return counts
}

const indexingTripleFor = async (
  prisma: PrismaClient,
  rows: readonly SubtreeRow[],
): Promise<KnowledgeItemInfo['indexing']> => {
  const states = await indexingStatesFor(prisma, rows.map((row) => ({
    id: row.id,
    kind: row.kind,
    status: row.status,
    publishedVersionId: row.publishedVersionId,
  })))
  const triple = { indexed: 0, pending: 0, notIndexed: 0 }
  for (const state of states.values()) {
    if (state.state === 'indexed') triple.indexed += 1
    else if (state.state === 'pending') triple.pending += 1
    // A folder has nothing to index and is counted in none of the three.
    else if (state.state !== 'not_applicable') triple.notIndexed += 1
  }
  return triple
}

const latestUpdate = (rows: readonly SubtreeRow[], fallback: string): string => {
  let newest: Date | null = null
  for (const row of rows) {
    if (newest === null || row.updatedAt > newest) newest = row.updatedAt
  }
  return newest?.toISOString() ?? fallback
}

const spaceHomeFacts = async (
  prisma: PrismaClient,
  space: KnowledgeSpaceRecord,
): Promise<{
  spaceId: string
  spaceName: string
  spaceMetadata: unknown
  ownerAgentId: string | null
  projectId: string
  projectName: string | null
}> => {
  const project = await prisma.project.findFirst({
    where: { id: space.projectId },
    select: { name: true },
  })
  return {
    spaceId: space.id,
    spaceName: space.name,
    spaceMetadata: space.metadata,
    ownerAgentId: space.ownerAgentId,
    projectId: space.projectId,
    projectName: project?.name ?? null,
  }
}

/** Get Info for one page and everything filed under it. */
export const getKnowledgePageInfo = async (
  prisma: PrismaClient,
  input: PageInfoInput,
): Promise<KnowledgeItemInfo> => {
  const { rows, truncated } = await walkSubtree(prisma, input.organizationId, {
    pageId: input.page.id,
  }, input.rowCap)
  const pageIds = rows.map((row) => row.id)
  const [sizes, indexing, ancestors, homeFacts, shareCount, facts] = await Promise.all([
    sizesFor(prisma, pageIds),
    indexingTripleFor(prisma, rows),
    ancestorPathsFor(prisma, [input.page.id]),
    spaceHomeFacts(prisma, input.space),
    prisma.knowledgePageShare.count({ where: { pageId: input.page.id } }),
    pageRowFactsFor(prisma, [{ id: input.page.id, kind: input.page.kind }]),
  ])
  const parentPath = ancestors.get(input.page.id) ?? []
  const access = await accessSummaryFor(prisma, {
    space: input.space,
    viewer: input.viewer,
    canManageAccess: input.canManageAccess,
    shareChainPageIds: [input.page.id, ...parentPath.map((entry) => entry.id)],
    shareCount,
  })
  const currentVersionFacts = rows.find((row) => row.id === input.page.id)
  return {
    id: input.page.id,
    target: 'page',
    kind: input.page.kind,
    title: input.page.title,
    // A file's own type. A document and a folder have none.
    mime: facts.get(input.page.id)?.mime ?? null,
    sizeBytes: sizes.currentSizeBytes.toString(),
    storageBytes: (
      sizes.versionAttachmentBytes + sizes.drawerAttachmentBytes + sizes.documentBodyBytes
    ).toString(),
    retainedVersions: Number(sizes.attachmentVersions - sizes.currentAttachmentVersions),
    // What is *inside* it: the item itself is not one of its own contents.
    counts: countsFor(rows.filter((row) => row.id !== input.page.id)),
    truncated,
    // The triple covers the whole subtree *including* the item, so Get Info on
    // a single file can still say whether that file is searchable.
    indexing,
    createdBy: input.page.createdBy,
    createdAt: input.page.createdAt,
    updatedAt: latestUpdate(rows, input.page.createdAt),
    home: buildKnowledgeHome(homeFacts, parentPath),
    access,
    taskId: currentVersionFacts?.taskId ?? input.page.taskId,
  }
}

/** Get Info for a root folder — a space and everything in it. */
export const getKnowledgeSpaceInfo = async (
  prisma: PrismaClient,
  input: SpaceInfoInput,
): Promise<KnowledgeItemInfo> => {
  const { rows, truncated } = await walkSubtree(prisma, input.organizationId, {
    spaceId: input.space.id,
  }, input.rowCap)
  const pageIds = rows.map((row) => row.id)
  const [sizes, indexing, homeFacts, shareCount] = await Promise.all([
    sizesFor(prisma, pageIds),
    indexingTripleFor(prisma, rows),
    spaceHomeFacts(prisma, input.space),
    prisma.knowledgePageShare.count({ where: { spaceId: input.space.id } }),
  ])
  const access = await accessSummaryFor(prisma, {
    space: input.space,
    viewer: input.viewer,
    canManageAccess: input.canManageAccess,
    shareChainPageIds: [],
    shareCount,
  })
  return {
    id: input.space.id,
    target: 'space',
    kind: 'space',
    title: input.space.name,
    mime: null,
    sizeBytes: sizes.currentSizeBytes.toString(),
    // The ledger is exact for a space and already paid for; a sum over the
    // subtree would disagree with the quota the same screen shows.
    storageBytes: input.storageBytes.toString(),
    retainedVersions: Number(sizes.attachmentVersions - sizes.currentAttachmentVersions),
    counts: countsFor(rows),
    truncated,
    indexing,
    createdBy: input.space.createdBy,
    createdAt: input.space.createdAt,
    updatedAt: latestUpdate(rows, input.space.updatedAt),
    home: buildKnowledgeHome(homeFacts, []),
    access,
    taskId: null,
  }
}
