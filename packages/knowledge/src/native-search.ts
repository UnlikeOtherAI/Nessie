import { Prisma, type PrismaClient } from '@prisma/client'
import { clampLimit, parseCursor, trimPage } from './pagination.js'
import { normalizeLabels } from './native-labels.js'
import { mapPage, pageInclude } from './native-mappers.js'
import type {
  KnowledgePageCursorPage,
  KnowledgeSearchHit,
  SearchPagesInput,
} from './types.js'

type SearchRow = {
  id: string
  snippet: string | null
  updatedAt: Date
}

export const searchNativePages = async (
  prisma: PrismaClient,
  input: SearchPagesInput,
): Promise<KnowledgePageCursorPage<KnowledgeSearchHit>> => {
  const limit = clampLimit(input.limit)
  const cursor = parseCursor(input.cursor)
  const query = input.query?.trim()
  const likeQuery = query ? `%${query}%` : null
  const labels = normalizeLabels(input.labels).map((label) => label.normalizedName)
  const rows = await prisma.$queryRaw<SearchRow[]>(Prisma.sql`
    SELECT p.id, p.updated_at AS "updatedAt",
           COALESCE(p.summary, p.title) AS snippet
    FROM knowledge_pages p
    JOIN knowledge_spaces s ON s.id = p.space_id
    WHERE p.organization_id = ${input.organizationId}::uuid
      AND p.deleted_at IS NULL
      AND p.status <> 'archived'::"KnowledgePageStatus"
      AND s.deleted_at IS NULL
      ${input.projectId ? Prisma.sql`AND p.project_id = ${input.projectId}::uuid` : Prisma.empty}
      ${input.spaceId ? Prisma.sql`AND p.space_id = ${input.spaceId}::uuid` : Prisma.empty}
      ${cursor
        ? Prisma.sql`
          AND (
            p.updated_at < ${cursor.cursorDate}
            OR (p.updated_at = ${cursor.cursorDate} AND p.id < ${cursor.cursorId}::uuid)
          )`
        : Prisma.empty}
      ${likeQuery
        ? Prisma.sql`
          AND (
            p.title ILIKE ${likeQuery}
            OR COALESCE(p.summary, '') ILIKE ${likeQuery}
            OR COALESCE(p.metadata::text, '') ILIKE ${likeQuery}
            OR EXISTS (
              SELECT 1 FROM page_labels pl
              WHERE pl.page_id = p.id
                AND pl.normalized_name ILIKE ${likeQuery.toLowerCase()}
            )
          )`
        : Prisma.empty}
      ${labels.length > 0
        ? Prisma.sql`
          AND p.id IN (
            SELECT pl.page_id
            FROM page_labels pl
            WHERE pl.normalized_name IN (${Prisma.join(labels)})
            GROUP BY pl.page_id
            HAVING COUNT(DISTINCT pl.normalized_name) = ${labels.length}
          )`
        : Prisma.empty}
    ORDER BY p.updated_at DESC, p.id DESC
    LIMIT ${limit + 1}
  `)
  const pageIds = rows.map((row) => row.id)
  const pages = await prisma.knowledgePage.findMany({
    where: { id: { in: pageIds } },
    include: pageInclude,
  })
  const pagesById = new Map(pages.map((page) => [page.id, mapPage(page)]))
  const hits: Array<KnowledgeSearchHit & { id: string; updatedAt: string }> = rows
    .map((row) => {
      const page = pagesById.get(row.id)
      return page
        ? {
            id: row.id,
            updatedAt: row.updatedAt.toISOString(),
            page,
            snippet: row.snippet ?? page.title,
          }
        : null
    })
    .filter((hit): hit is KnowledgeSearchHit & { id: string; updatedAt: string } => hit !== null)
  const page = trimPage(hits, limit)
  return {
    data: page.data.map(({ page: hitPage, snippet }) => ({ page: hitPage, snippet })),
    meta: page.meta,
  }
}
