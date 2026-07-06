import { Prisma, type PrismaClient } from '@prisma/client'
import {
  fuseHybridCandidates,
  toVectorLiteral,
  type FusedRetrievalResult,
  type RankedRetrievalCandidate,
  type RetrievalCandidateBase,
} from '@nessie/retrieval'
import { mapPage, pageInclude } from './native-mappers.js'
import { readableSpaceIdsSql } from './native-search-access.js'
import type {
  HybridSearchPagesInput,
  KnowledgePageCursorPage,
  KnowledgeSearchHit,
  KnowledgeSearchPassage,
} from './types.js'

// Per-channel candidate pool size, before RRF fusion narrows it down.
const CHANNEL_CANDIDATE_LIMIT = 40
// Fused candidate pool handed to the page-grouping step.
const FUSED_CANDIDATE_LIMIT = 60
const SNIPPET_MAX_LENGTH = 280
const MAX_PASSAGES_PER_PAGE = 3
const DEFAULT_PAGE_LIMIT = 20
const MAX_PAGE_LIMIT = 50

type ChunkCandidateRow = {
  id: string
  pageId: string
  content: string
  startOffset: number
  endOffset: number
  updatedAt: Date
}

type ChunkCandidate = RetrievalCandidateBase & {
  pageId: string
  content: string
  startOffset: number
  endOffset: number
}

const clampPageLimit = (limit?: number): number =>
  Math.min(Math.max(limit ?? DEFAULT_PAGE_LIMIT, 1), MAX_PAGE_LIMIT)

// Predicates shared by the lexical and semantic candidate queries: same
// organization/lifecycle/scope filters, restricted to the latest version's
// chunks and (when a non-bypass viewer is supplied) the spaces they may read.
const sharedChunkWhere = (input: HybridSearchPagesInput): Prisma.Sql => Prisma.sql`
  c.organization_id = ${input.organizationId}::uuid
  AND p.deleted_at IS NULL
  AND p.status <> 'archived'::"KnowledgePageStatus"
  ${input.projectId ? Prisma.sql`AND p.project_id = ${input.projectId}::uuid` : Prisma.empty}
  ${input.spaceId ? Prisma.sql`AND p.space_id = ${input.spaceId}::uuid` : Prisma.empty}
  ${input.viewer && !input.viewer.bypass
    ? Prisma.sql`AND p.space_id IN (${readableSpaceIdsSql(input.organizationId, input.viewer)})`
    : Prisma.empty}
`

// Only the latest version's chunks are current; older versions' chunk rows
// must never surface in search.
const latestVersionJoin = Prisma.sql`
  JOIN LATERAL (
    SELECT id FROM knowledge_page_versions v
    WHERE v.page_id = c.page_id
    ORDER BY v.version_number DESC
    LIMIT 1
  ) lv ON lv.id = c.version_id
`

const runLexicalQuery = (
  prisma: PrismaClient,
  input: HybridSearchPagesInput,
  query: string,
): Promise<ChunkCandidateRow[]> =>
  prisma.$queryRaw<ChunkCandidateRow[]>(Prisma.sql`
    SELECT c.id, c.page_id AS "pageId", c.content,
           c.start_offset AS "startOffset", c.end_offset AS "endOffset",
           p.updated_at AS "updatedAt"
    FROM knowledge_page_chunks c
    JOIN knowledge_pages p ON p.id = c.page_id
    ${latestVersionJoin}
    WHERE ${sharedChunkWhere(input)}
      AND c.search_vector @@ websearch_to_tsquery('english', ${query})
    ORDER BY ts_rank_cd(c.search_vector, websearch_to_tsquery('english', ${query})) DESC
    LIMIT ${CHANNEL_CANDIDATE_LIMIT}
  `)

const runSemanticQuery = (
  prisma: PrismaClient,
  input: HybridSearchPagesInput,
  vectorLiteral: string,
): Promise<ChunkCandidateRow[]> =>
  prisma.$queryRaw<ChunkCandidateRow[]>(Prisma.sql`
    SELECT c.id, c.page_id AS "pageId", c.content,
           c.start_offset AS "startOffset", c.end_offset AS "endOffset",
           p.updated_at AS "updatedAt"
    FROM knowledge_page_chunks c
    JOIN knowledge_pages p ON p.id = c.page_id
    ${latestVersionJoin}
    WHERE ${sharedChunkWhere(input)}
      AND c.embedding IS NOT NULL
    ORDER BY c.embedding <=> ${vectorLiteral}::vector ASC
    LIMIT ${CHANNEL_CANDIDATE_LIMIT}
  `)

const toRankedCandidates = (
  rows: ChunkCandidateRow[],
): RankedRetrievalCandidate<ChunkCandidate>[] =>
  rows.map((row, index) => ({
    candidate: {
      id: row.id,
      createdAt: row.updatedAt,
      pageId: row.pageId,
      content: row.content,
      startOffset: row.startOffset,
      endOffset: row.endOffset,
    },
    rank: index + 1,
  }))

export type GroupedPageHit = {
  pageId: string
  score: number
  passages: KnowledgeSearchPassage[]
}

// Groups fused chunk results by page, keeping up to MAX_PASSAGES_PER_PAGE best
// passages per page. `fused` is already sorted by similarity descending, so
// the first chunk seen for a page is that page's best chunk — which is why
// the page order below (order of first appearance) is exactly "best chunk
// score descending" without a second sort pass.
export const groupFusedChunksByPage = (
  fused: FusedRetrievalResult<ChunkCandidate>[],
  limit: number,
): GroupedPageHit[] => {
  const byPage = new Map<string, GroupedPageHit>()
  const pageOrder: string[] = []
  for (const result of fused) {
    const { candidate, similarity } = result
    let entry = byPage.get(candidate.pageId)
    if (!entry) {
      entry = { pageId: candidate.pageId, score: similarity, passages: [] }
      byPage.set(candidate.pageId, entry)
      pageOrder.push(candidate.pageId)
    }
    if (entry.passages.length < MAX_PASSAGES_PER_PAGE) {
      entry.passages.push({
        content: candidate.content,
        startOffset: candidate.startOffset,
        endOffset: candidate.endOffset,
        score: similarity,
      })
    }
  }
  return pageOrder.slice(0, limit).map((pageId) => {
    const entry = byPage.get(pageId)
    if (!entry) throw new Error(`Missing grouped entry for page ${pageId}`)
    return entry
  })
}

// Truncates snippet content to a word boundary, appending an ellipsis when
// truncated. Pure so it is unit-testable without a database.
export const truncateSnippet = (
  content: string,
  maxLength: number = SNIPPET_MAX_LENGTH,
): string => {
  if (content.length <= maxLength) return content
  const truncated = content.slice(0, maxLength)
  const lastSpace = truncated.lastIndexOf(' ')
  const boundary = lastSpace > 0 ? truncated.slice(0, lastSpace) : truncated
  return `${boundary}…`
}

// A snippet must show WHY the passage matched: when the first query-term
// occurrence sits past the truncation window, a plain head-truncation hides
// the match entirely. Window the snippet around the first matching term
// (word-boundary aligned) instead; fall back to head truncation when no term
// occurs literally (e.g. semantic-only matches).
export const snippetAroundMatch = (
  content: string,
  query: string,
  maxLength: number = SNIPPET_MAX_LENGTH,
): string => {
  if (content.length <= maxLength) return content
  const terms = query.toLowerCase().split(/\W+/).filter((term) => term.length >= 3)
  const haystack = content.toLowerCase()
  let matchIndex = -1
  for (const term of terms) {
    const index = haystack.indexOf(term)
    if (index >= 0 && (matchIndex === -1 || index < matchIndex)) matchIndex = index
  }
  if (matchIndex === -1 || matchIndex + maxLength / 2 <= maxLength) {
    return truncateSnippet(content, maxLength)
  }
  const windowStart = Math.max(0, matchIndex - Math.floor(maxLength / 4))
  const alignedStart = content.indexOf(' ', windowStart)
  const start = alignedStart >= 0 && alignedStart < matchIndex ? alignedStart + 1 : windowStart
  return `…${truncateSnippet(content.slice(start), maxLength - 1)}`
}

export const searchNativePagesHybrid = async (
  prisma: PrismaClient,
  input: HybridSearchPagesInput,
): Promise<KnowledgePageCursorPage<KnowledgeSearchHit>> => {
  const limit = clampPageLimit(input.limit)
  const query = input.query.trim()
  if (!query) {
    return { data: [], meta: { cursor: null, hasMore: false } }
  }

  const vectorLiteral = toVectorLiteral(input.queryEmbedding)
  const [lexicalRows, semanticRows] = await Promise.all([
    runLexicalQuery(prisma, input, query),
    vectorLiteral ? runSemanticQuery(prisma, input, vectorLiteral) : Promise.resolve([]),
  ])

  const fused = fuseHybridCandidates({
    lexicalCandidates: toRankedCandidates(lexicalRows),
    semanticCandidates: toRankedCandidates(semanticRows),
    limit: FUSED_CANDIDATE_LIMIT,
  })
  const grouped = groupFusedChunksByPage(fused, limit)
  if (grouped.length === 0) {
    return { data: [], meta: { cursor: null, hasMore: false } }
  }

  const pages = await prisma.knowledgePage.findMany({
    where: {
      id: { in: grouped.map((group) => group.pageId) },
      organizationId: input.organizationId,
      deletedAt: null,
      status: { not: 'archived' },
    },
    include: pageInclude,
  })
  const pagesById = new Map(pages.map((page) => [page.id, mapPage(page)]))

  const hits: KnowledgeSearchHit[] = grouped
    .map((group): KnowledgeSearchHit | null => {
      const page = pagesById.get(group.pageId)
      if (!page) return null
      const bestPassage = group.passages[0]
      return {
        page,
        snippet: bestPassage ? snippetAroundMatch(bestPassage.content, query) : page.title,
        passages: group.passages,
        score: group.score,
      }
    })
    .filter((hit): hit is KnowledgeSearchHit => hit !== null)

  return { data: hits, meta: { cursor: null, hasMore: false } }
}
