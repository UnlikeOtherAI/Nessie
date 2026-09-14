import { Prisma, type PrismaClient } from '@prisma/client'
import { readableSpaceIdsSqlForViewer } from './native-search-access.js'
import type { DisclosureViewer } from '@nessie/runtime'
import type {
  KnowledgePageKind,
  KnowledgePageStatus,
  KnowledgeRecentPageRecord,
  ListRecentPagesInput,
} from './types.js'

const DEFAULT_RECENT_LIMIT = 5
const MAX_RECENT_LIMIT = 20

type RecentPageRow = {
  id: string
  spaceId: string
  spaceName: string
  title: string
  kind: KnowledgePageKind
  status: KnowledgePageStatus
  updatedAt: Date
}

const readableVersionSql = (viewer: DisclosureViewer | undefined): Prisma.Sql => {
  if (!viewer) return Prisma.empty
  if (viewer.kind === 'denied') return Prisma.sql`AND FALSE`
  if (viewer.kind === 'autonomous') {
    return Prisma.sql`AND NOT EXISTS (
      SELECT 1 FROM knowledge_page_versions v
      WHERE v.page_id = p.id AND (
        EXISTS (SELECT 1 FROM knowledge_page_version_basis_scopes b WHERE b.version_id = v.id)
        OR EXISTS (
          SELECT 1 FROM knowledge_page_version_disclosure_sources ds
          WHERE ds.version_id = v.id AND ds.source_author_user_id IS NULL
        )
      )
    )`
  }
  const reachable = viewer.scopes.map((scope) =>
    Prisma.sql`(b.scope_type = ${scope.scopeType} AND b.scope_id = ${scope.scopeId}::uuid)`)
  const reachableClause = reachable.length > 0
    ? Prisma.join(reachable, ' OR ')
    : Prisma.sql`FALSE`
  return Prisma.sql`AND NOT EXISTS (
    SELECT 1 FROM knowledge_page_versions v
    WHERE v.page_id = p.id AND (
      EXISTS (
        SELECT 1 FROM knowledge_page_version_disclosure_sources ds
        WHERE ds.version_id = v.id AND ds.source_author_user_id IS NULL
      ) OR EXISTS (
        SELECT 1 FROM knowledge_page_version_basis_scopes b
        WHERE b.version_id = v.id
          AND NOT (${reachableClause})
      )
    )
  )`
}

export const clampRecentLimit = (limit?: number): number =>
  Math.min(Math.max(Math.trunc(limit ?? DEFAULT_RECENT_LIMIT), 1), MAX_RECENT_LIMIT)

// "What was written down lately in this project", across every space the
// caller may read. Deliberately not a search: no query, no snippets, no
// scoring — just the newest pages, ordered the way the
// (organization_id, project_id, updated_at desc, id desc) index already
// stores them. Read access reuses the same `readableSpaceIdsSqlForViewer`
// pre-filter the search path uses, so there is exactly one space-read rule
// (mirroring `canReadSpace`) rather than a second one written here.
export const listNativeRecentPages = async (
  prisma: PrismaClient,
  input: ListRecentPagesInput,
): Promise<KnowledgeRecentPageRecord[]> => {
  const limit = clampRecentLimit(input.limit)
  const spaceFilter = input.viewer
    ? readableSpaceIdsSqlForViewer(input.organizationId, input.viewer)
    : null
  const versionFilter = readableVersionSql(input.disclosureViewer)
  const rows = await prisma.$queryRaw<RecentPageRow[]>(Prisma.sql`
    SELECT p.id,
           p.space_id AS "spaceId",
           s.name AS "spaceName",
           p.title,
           p.kind,
           p.status,
           p.updated_at AS "updatedAt"
    FROM knowledge_pages p
    JOIN knowledge_spaces s ON s.id = p.space_id
    WHERE p.organization_id = ${input.organizationId}::uuid
      AND p.project_id = ${input.projectId}::uuid
      AND p.deleted_at IS NULL
      AND p.status <> 'archived'::"KnowledgePageStatus"
      AND s.deleted_at IS NULL
      ${spaceFilter ? Prisma.sql`AND p.space_id IN (${spaceFilter})` : Prisma.empty}
      ${versionFilter}
    ORDER BY p.updated_at DESC, p.id DESC
    LIMIT ${limit}
  `)
  return rows.map((row) => ({
    id: row.id,
    spaceId: row.spaceId,
    spaceName: row.spaceName,
    title: row.title,
    kind: row.kind,
    status: row.status,
    updatedAt: row.updatedAt.toISOString(),
  }))
}
