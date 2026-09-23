import { Prisma, type PrismaClient } from '@prisma/client'
import { toVectorLiteral } from '@nessie/retrieval'
import { buildPrefixTsQuery } from '@nessie/runtime'
import { EMBEDDING_DIMENSIONS, type PaginationMeta } from '@nessie/schemas'

import {
  mapProjectTask,
  projectTaskInclude,
  type ProjectTaskRecord,
} from './project-task-records.js'

type RankedTaskRow = { id: string }

export type HybridProjectTaskSearchInput = {
  embeddingModel: string | null
  limit?: number
  organizationId: string
  projectIds?: string[]
  query: string
  queryEmbedding: number[] | null
}

export type HybridProjectTaskSearchOptions = {
  isReadable: (task: ProjectTaskRecord) => Promise<boolean>
}

export type HybridProjectTaskSearchPage = {
  data: ProjectTaskRecord[]
  meta: PaginationMeta
}

const emptyMeta = (): PaginationMeta => ({
  hasMore: false,
  nextCursor: null,
  prevCursor: null,
})

/**
 * Relevance-ranked ticket search for the human global-search surface. The
 * lexical and vector arms both emit ids only; canonical task rows are loaded
 * afterwards and pass the same run-disclosure predicate as every other task
 * reader before any title reaches the caller.
 */
export const searchProjectTasksHybrid = async (
  prisma: PrismaClient,
  input: HybridProjectTaskSearchInput,
  options: HybridProjectTaskSearchOptions,
): Promise<HybridProjectTaskSearchPage> => {
  if (input.projectIds?.length === 0) return { data: [], meta: emptyMeta() }
  const prefixQuery = buildPrefixTsQuery(input.query)
  if (!prefixQuery) return { data: [], meta: emptyMeta() }
  const limit = Math.min(Math.max(input.limit ?? 50, 1), 100)
  // Oversample before the per-run disclosure pass, which may remove rows.
  const candidateLimit = Math.min(limit * 4, 400)
  const vector = toVectorLiteral(input.queryEmbedding)
  const projectFilter = input.projectIds
    ? Prisma.sql`t.project_id IN (${Prisma.join(
        input.projectIds.map((id) => Prisma.sql`${id}::uuid`),
      )})`
    : Prisma.sql`TRUE`

  const candidates = await prisma.$queryRaw<RankedTaskRow[]>(Prisma.sql`
    WITH eligible AS (
      SELECT
        t.id,
        t.updated_at,
        tel.external_key,
        to_tsvector(
          'english',
          coalesce(t.title, '') || ' ' || coalesce(t.purpose, '') || ' '
            || coalesce(t.detail, '')
        ) AS search_document
      FROM tasks t
      JOIN projects p ON p.id = t.project_id
      LEFT JOIN task_external_links tel ON tel.task_id = t.id
      WHERE t.organization_id = ${input.organizationId}::uuid
        AND t.project_id IS NOT NULL
        AND t.archived_at IS NULL
        AND p.deleted_at IS NULL
        AND p.channel_root = false
        AND ${projectFilter}
    ), lexical AS (
      SELECT e.id, row_number() OVER (
        ORDER BY (
          ts_rank_cd(e.search_document, query)
          + CASE
              WHEN lower(coalesce(e.external_key, '')) = lower(${input.query}) THEN 2
              WHEN coalesce(e.external_key, '') ILIKE ${`${input.query}%`} THEN 1
              WHEN coalesce(e.external_key, '') ILIKE ${`%${input.query}%`} THEN 0.25
              ELSE 0
            END
        ) DESC, e.updated_at DESC, e.id
      ) AS rank
      FROM eligible e, to_tsquery('english', ${prefixQuery}) query
      WHERE e.search_document @@ query
         OR coalesce(e.external_key, '') ILIKE ${`%${input.query}%`}
      ORDER BY (
        ts_rank_cd(e.search_document, query)
        + CASE
            WHEN lower(coalesce(e.external_key, '')) = lower(${input.query}) THEN 2
            WHEN coalesce(e.external_key, '') ILIKE ${`${input.query}%`} THEN 1
            WHEN coalesce(e.external_key, '') ILIKE ${`%${input.query}%`} THEN 0.25
            ELSE 0
          END
      ) DESC, e.updated_at DESC, e.id
      LIMIT ${candidateLimit}
    ), semantic AS (
      SELECT e.id, row_number() OVER (
        ORDER BY te.embedding <=> ${vector}::vector, e.updated_at DESC, e.id
      ) AS rank
      FROM eligible e
      JOIN task_embeddings te ON te.task_id = e.id
      WHERE ${vector}::vector IS NOT NULL
        AND te.status = 'indexed'
        AND te.embedding IS NOT NULL
        AND te.embedding_model = ${input.embeddingModel}
        AND te.dims = ${EMBEDDING_DIMENSIONS}
        AND 1 - (te.embedding <=> ${vector}::vector) >= 0.3
      ORDER BY te.embedding <=> ${vector}::vector, e.updated_at DESC, e.id
      LIMIT ${candidateLimit}
    ), ranked AS (
      SELECT
        COALESCE(lexical.id, semantic.id) AS id,
        lexical.rank AS lexical_rank,
        semantic.rank AS semantic_rank
      FROM lexical FULL OUTER JOIN semantic ON semantic.id = lexical.id
    )
    SELECT r.id
    FROM ranked r
    JOIN eligible e ON e.id = r.id
    ORDER BY
      (COALESCE(1.0 / (60 + r.lexical_rank), 0)
        + COALESCE(1.0 / (60 + r.semantic_rank), 0)) DESC,
      e.updated_at DESC,
      r.id
    LIMIT ${candidateLimit}
  `)
  if (candidates.length === 0) return { data: [], meta: emptyMeta() }

  const tasks = await prisma.task.findMany({
    where: { id: { in: candidates.map((candidate) => candidate.id) } },
    include: projectTaskInclude,
  })
  const taskById = new Map(tasks.map((task) => [task.id, mapProjectTask(task)]))
  const ranked = candidates.flatMap((candidate) => {
    const task = taskById.get(candidate.id)
    return task ? [task] : []
  })
  const permitted = await Promise.all(ranked.map(options.isReadable))
  return {
    data: ranked.filter((_task, index) => permitted[index]).slice(0, limit),
    meta: emptyMeta(),
  }
}
