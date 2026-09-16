import { EMBEDDING_DIMENSIONS } from '@nessie/schemas'
import { fuseHybridCandidates } from './fusion.js'
import { toVectorLiteral, type Queryable } from './query.js'

export type MessageSearchCandidate = {
  createdAt: Date | string
  id: string
  lexicalRank: number | null
  semanticRank: number | null
}

export type SearchMessageCandidatesInput = {
  /** Freshly resolved reachable channel ids; text never crosses this boundary. */
  channelIds: readonly string[]
  embeddingModel: string
  organizationId: string
  /** Scope pairs held by the current effective person or explicit agent binding. */
  scopeIds: readonly string[]
  scopeTypes: readonly string[]
  query: string
  queryEmbedding: number[] | null
  runningAgentId: string
  take?: number
}

/**
 * Produce only canonical Message ids and ranks. A later reader reloads the
 * messages, their exact basis and lineage before any text is materialized.
 * Each candidate arm is bounded before reciprocal-rank fusion; lexical search
 * uses the existing messages FTS index, and semantic search uses the message
 * vector index. No transcript copy is queried or returned here.
 */
export const searchMessageCandidates = async (
  input: SearchMessageCandidatesInput,
  db: Queryable,
): Promise<MessageSearchCandidate[]> => {
  if (
    input.channelIds.length === 0
    || input.scopeIds.length !== input.scopeTypes.length
  ) return []

  const take = Math.min(Math.max(input.take ?? 12, 1), 50)
  const result = await db.query(
    `WITH scope_set AS (
       SELECT * FROM unnest($1::text[], $2::uuid[]) AS s(audience_type, audience_id)
     ), semantic AS (
       SELECT m.id, m.created_at,
              row_number() OVER (ORDER BY me.embedding <=> $8::vector, m.id) AS rank
       FROM message_embeddings me
       JOIN messages m ON m.id = me.message_id
       JOIN threads t ON t.id = m.thread_id
       JOIN channels c ON c.id = t.channel_id
       WHERE $8::vector IS NOT NULL
         AND me.embedding IS NOT NULL
         AND me.embedding_model = $6
         AND me.dims = $7
         AND m.deleted_at IS NULL
         AND c.organization_id = $5::uuid
         AND t.channel_id = ANY($3::uuid[])
         AND NOT EXISTS (
           SELECT 1 FROM message_basis_scopes mbs
           WHERE mbs.message_id = m.id
             AND NOT (
               (mbs.scope_type = 'agent' AND mbs.scope_id = $4::uuid)
               OR EXISTS (
                 SELECT 1 FROM scope_set ss
                 WHERE ss.audience_type = mbs.scope_type
                   AND ss.audience_id = mbs.scope_id
               )
             )
         )
       ORDER BY me.embedding <=> $8::vector, m.id
       LIMIT $10
     ), lexical AS (
       SELECT m.id, m.created_at,
              row_number() OVER (
                ORDER BY ts_rank_cd(to_tsvector('english', m.content), query) DESC, m.id
              ) AS rank
       FROM messages m
       JOIN threads t ON t.id = m.thread_id
       JOIN channels c ON c.id = t.channel_id,
            websearch_to_tsquery('english', $9) query
       WHERE m.deleted_at IS NULL
         AND c.organization_id = $5::uuid
         AND t.channel_id = ANY($3::uuid[])
         AND to_tsvector('english', m.content) @@ query
         AND NOT EXISTS (
           SELECT 1 FROM message_basis_scopes mbs
           WHERE mbs.message_id = m.id
             AND NOT (
               (mbs.scope_type = 'agent' AND mbs.scope_id = $4::uuid)
               OR EXISTS (
                 SELECT 1 FROM scope_set ss
                 WHERE ss.audience_type = mbs.scope_type
                   AND ss.audience_id = mbs.scope_id
               )
             )
         )
       ORDER BY ts_rank_cd(to_tsvector('english', m.content), query) DESC, m.id
       LIMIT $10
     )
     SELECT COALESCE(semantic.id, lexical.id) AS id,
            COALESCE(semantic.created_at, lexical.created_at) AS "createdAt",
            lexical.rank::integer AS "lexicalRank",
            semantic.rank::integer AS "semanticRank"
     FROM semantic FULL OUTER JOIN lexical ON lexical.id = semantic.id`,
    [
      [...input.scopeTypes],
      [...input.scopeIds],
      [...input.channelIds],
      input.runningAgentId,
      input.organizationId,
      input.embeddingModel,
      EMBEDDING_DIMENSIONS,
      toVectorLiteral(input.queryEmbedding),
      input.query,
      take * 4,
    ],
  )
  const rows = result.rows as MessageSearchCandidate[]
  const candidates = new Map(rows.map((row) => [row.id, {
    createdAt: row.createdAt,
    id: row.id,
  }]))
  const fused = fuseHybridCandidates({
    lexicalCandidates: rows.flatMap((row) => {
      const candidate = candidates.get(row.id)
      return candidate && row.lexicalRank !== null
        ? [{ candidate, rank: row.lexicalRank }]
        : []
    }),
    limit: take,
    semanticCandidates: rows.flatMap((row) => {
      const candidate = candidates.get(row.id)
      return candidate && row.semanticRank !== null
        ? [{ candidate, rank: row.semanticRank }]
        : []
    }),
  })
  const rowById = new Map(rows.map((row) => [row.id, row]))
  return fused.flatMap(({ candidate }) => {
    const row = rowById.get(candidate.id)
    return row ? [{ ...row, createdAt: candidate.createdAt }] : []
  })
}
