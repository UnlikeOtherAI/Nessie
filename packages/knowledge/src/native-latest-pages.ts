import { Prisma, type PrismaClient } from '@prisma/client'
import type { DisclosureViewer } from '@nessie/runtime'
import type { KnowledgeHome, KnowledgeVirtualRow } from '@nessie/schemas'

import type { SpaceViewer } from './access.js'
import { indexingStatesFor } from './native-indexing-status.js'
import { pageRowFactsFor } from './native-list-enrichment.js'
import { readableSpaceIdsSqlForViewer } from './native-search-access.js'
import { readableVersionSql } from './native-recent-pages.js'
import { clampLimit, encodeCursor, parseCursor } from './pagination.js'
import type { KnowledgePageStatus } from './types.js'

/**
 * "Latest" — the Finder's first virtual folder: everything the viewer can read,
 * newest change first, across every root folder.
 *
 * Viewer-scoped in SQL by the one space-read rule (`readableSpaceIdsSqlForViewer`,
 * mirroring `canReadSpace`) and by the same version-basis predicate the recency
 * list uses. The route still runs the rows through `filterReadablePages` before
 * returning them: space membership alone is not sufficient for a
 * private-derived version, and a listing that names a page the viewer cannot
 * open is the one failure this endpoint must never produce.
 *
 * Contract: docs/plans/2026-09-16-documents-finder-ui/data-and-api.md §3.
 *
 * Deviation from the design, forced by the code: the design specified a
 * `base64url({ updatedAt, id })` cursor. This package already has exactly one
 * keyset cursor grammar — `encodeCursor`/`parseCursor` in `pagination.ts`,
 * `"<iso>|<id>"` — and a second one would be a second thing to keep opaque.
 */

const MAX_LATEST_LIMIT = 100
const DEFAULT_LATEST_LIMIT = 50
// Deep trees are legal; an ancestor walk that could not terminate is not.
const MAX_ANCESTOR_DEPTH = 64

export type ListLatestPagesInput = {
  organizationId: string
  viewer: SpaceViewer
  disclosureViewer?: DisclosureViewer
  // Project scope (the project's Docs tab) narrows to that project's spaces.
  projectId?: string
  cursor?: string
  limit?: number
}

export type LatestPageRow = KnowledgeVirtualRow

type LatestSqlRow = {
  id: string
  kind: 'document' | 'file'
  title: string
  status: KnowledgePageStatus
  publishedVersionId: string | null
  parentPageId: string | null
  createdBy: string
  createdAt: Date
  updatedAt: Date
  spaceId: string
  spaceName: string
  spaceMetadata: unknown
  ownerAgentId: string | null
  spaceProjectId: string
  projectName: string | null
}

export type HomeSpaceFacts = {
  spaceId: string
  spaceName: string
  spaceMetadata: unknown
  ownerAgentId: string | null
  projectId: string
  projectName: string | null
}

const isFlagged = (metadata: unknown, flag: string): boolean =>
  typeof metadata === 'object'
  && metadata !== null
  && !Array.isArray(metadata)
  && (metadata as Record<string, unknown>)[flag] === true

/**
 * Which root folder a space is. Derived from the two metadata flags and
 * `ownerAgentId` — there is deliberately no `KnowledgeSpace.kind` column, which
 * would restate in a third place what these already say.
 */
export const rootKindForSpace = (space: {
  spaceMetadata: unknown
  ownerAgentId: string | null
}): KnowledgeHome['rootKind'] => {
  if (isFlagged(space.spaceMetadata, 'personal')) return 'personal'
  if (isFlagged(space.spaceMetadata, 'projectDocuments')) return 'project'
  if (space.ownerAgentId !== null) return 'agent'
  return 'shared'
}

/**
 * The ancestors of each page, root-of-space first, parent last. One recursive
 * walk for the whole page of rows rather than one per row.
 */
export const ancestorPathsFor = async (
  prisma: PrismaClient,
  pageIds: readonly string[],
): Promise<Map<string, Array<{ id: string; title: string }>>> => {
  const paths = new Map<string, Array<{ id: string; title: string }>>()
  for (const id of pageIds) paths.set(id, [])
  if (pageIds.length === 0) return paths
  const rows = await prisma.$queryRaw<Array<{
    rootId: string
    depth: number
    id: string
    title: string
  }>>(Prisma.sql`
    WITH RECURSIVE chain AS (
      SELECT p.id AS root_id, p.parent_page_id AS ancestor_id, 0 AS depth
      FROM knowledge_pages p
      WHERE p.id = ANY(${[...pageIds]}::uuid[])
      UNION ALL
      SELECT c.root_id, a.parent_page_id, c.depth + 1
      FROM chain c
      JOIN knowledge_pages a ON a.id = c.ancestor_id
      WHERE c.ancestor_id IS NOT NULL AND c.depth < ${MAX_ANCESTOR_DEPTH}
    )
    SELECT c.root_id AS "rootId", c.depth AS "depth", a.id AS "id", a.title AS "title"
    FROM chain c
    JOIN knowledge_pages a ON a.id = c.ancestor_id
    WHERE a.deleted_at IS NULL
    ORDER BY c.root_id, c.depth DESC
  `)
  for (const row of rows) {
    paths.get(row.rootId)?.push({ id: row.id, title: row.title })
  }
  return paths
}

/** Where an item lives: its root folder, and the folder path under it. */
export const buildKnowledgeHome = (
  space: HomeSpaceFacts,
  parentPath: Array<{ id: string; title: string }>,
): KnowledgeHome => ({
  spaceId: space.spaceId,
  spaceName: space.spaceName,
  rootKind: rootKindForSpace(space),
  projectId: space.projectId,
  projectName: space.projectName,
  ownerAgentId: space.ownerAgentId,
  parentPath,
})

export const clampLatestLimit = (limit?: number): number =>
  Math.min(clampLimit(limit ?? DEFAULT_LATEST_LIMIT), MAX_LATEST_LIMIT)

export const listNativeLatestPages = async (
  prisma: PrismaClient,
  input: ListLatestPagesInput,
): Promise<{ data: LatestPageRow[]; meta: { cursor: string | null; hasMore: boolean } }> => {
  const limit = clampLatestLimit(input.limit)
  const spaceFilter = readableSpaceIdsSqlForViewer(input.organizationId, input.viewer)
  const versionFilter = readableVersionSql(input.disclosureViewer)
  const cursor = parseCursor(input.cursor)
  const rows = await prisma.$queryRaw<LatestSqlRow[]>(Prisma.sql`
    SELECT p.id,
           p.kind,
           p.title,
           p.status,
           p.published_version_id AS "publishedVersionId",
           p.parent_page_id AS "parentPageId",
           p.created_by AS "createdBy",
           p.created_at AS "createdAt",
           p.updated_at AS "updatedAt",
           s.id AS "spaceId",
           s.name AS "spaceName",
           s.metadata AS "spaceMetadata",
           s.owner_agent_id AS "ownerAgentId",
           s.project_id AS "spaceProjectId",
           pr.name AS "projectName"
    FROM knowledge_pages p
    JOIN knowledge_spaces s ON s.id = p.space_id
    LEFT JOIN projects pr ON pr.id = s.project_id
    WHERE p.organization_id = ${input.organizationId}::uuid
      AND p.deleted_at IS NULL
      AND s.deleted_at IS NULL
      AND p.status <> 'archived'::"KnowledgePageStatus"
      -- Folders are containers, not changes: Latest is what was written.
      AND p.kind <> 'folder'::"KnowledgePageKind"
      ${input.projectId ? Prisma.sql`AND s.project_id = ${input.projectId}::uuid` : Prisma.empty}
      ${spaceFilter ? Prisma.sql`AND p.space_id IN (${spaceFilter})` : Prisma.empty}
      ${cursor
        ? Prisma.sql`AND (p.updated_at, p.id) < (${cursor.cursorDate}, ${cursor.cursorId}::uuid)`
        : Prisma.empty}
      ${versionFilter}
    ORDER BY p.updated_at DESC, p.id DESC
    LIMIT ${limit + 1}
  `)
  const hasMore = rows.length > limit
  const page = hasMore ? rows.slice(0, limit) : rows
  const last = page.at(-1)
  const meta = {
    cursor: hasMore && last ? encodeCursor(last.updatedAt, last.id) : null,
    hasMore,
  }
  if (page.length === 0) return { data: [], meta }

  const [facts, indexing, paths] = await Promise.all([
    pageRowFactsFor(prisma, page.map((row) => ({ id: row.id, kind: row.kind }))),
    indexingStatesFor(prisma, page.map((row) => ({
      id: row.id,
      kind: row.kind,
      status: row.status,
      publishedVersionId: row.publishedVersionId,
    }))),
    ancestorPathsFor(prisma, page.map((row) => row.id)),
  ])

  const data = page.map((row) => ({
    id: row.id,
    kind: row.kind,
    title: row.title,
    status: row.status,
    mime: facts.get(row.id)?.mime ?? null,
    sizeBytes: facts.get(row.id)?.sizeBytes ?? null,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    indexing: indexing.get(row.id) ?? { state: 'not_indexed' as const, reason: 'empty' as const },
    home: buildKnowledgeHome({
      spaceId: row.spaceId,
      spaceName: row.spaceName,
      spaceMetadata: row.spaceMetadata,
      ownerAgentId: row.ownerAgentId,
      projectId: row.spaceProjectId,
      projectName: row.projectName,
    }, paths.get(row.id) ?? []),
  }))
  return { data, meta }
}
