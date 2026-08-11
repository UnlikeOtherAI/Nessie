import { Prisma, type PrismaClient } from '@prisma/client'
import { readableSpaceIdsSqlForViewer } from './native-search-access.js'
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
