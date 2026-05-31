import type { ThoughtAudienceType, ThoughtSearchMode } from '@nessie/schemas'
import type { Queryable } from './query.js'
import { toVectorLiteral } from './query.js'

// Thought retrieval ranking currently lives in the `match_thoughts_*` PL/pgSQL
// functions, which perform RRF(k=60)+recency+outcome fusion in SQL. These
// helpers are the TypeScript invocation layer over those functions. The
// TypeScript fusion utilities in ./fusion.ts own the shared scoring constants
// and mirror the SQL math for future content types whose candidates are fused
// in TS; thoughts intentionally keep the SQL candidate path.

type SearchQuerySpec = {
  params: unknown[]
  sql: string
}

export type ThoughtSearchRow = {
  id: string
  content: string
  content_hash: string
  owner_id: string
  owner_type: string
  organization_id: string
  project_id: string | null
  team_id: string | null
  channel_id: string | null
  thread_id: string | null
  visibility: string
  sensitivity_tier: string
  importance: number
  metadata: unknown
  created_at: string
  similarity: number
}

export type SearchThoughtCandidatesInput = {
  mode: ThoughtSearchMode
  query: string
  queryEmbedding: number[] | null
  organizationId: string
  userId: string
  outputAudienceType: ThoughtAudienceType
  outputAudienceId: string
  threshold?: number
  limit?: number
}

export type SearchThoughtCandidatesInScopesInput = {
  query: string
  queryEmbedding: number[]
  organizationId: string
  audienceTypes: string[]
  audienceIds: string[]
  currentAudienceType: string
  currentAudienceId: string
  runningAgentId: string
  threshold?: number
  limit?: number
}

const buildThoughtSearchQuery = (
  input: SearchThoughtCandidatesInput,
): SearchQuerySpec => {
  const threshold = input.threshold ?? 0.3
  const limit = input.limit ?? 10
  const embeddingStr = toVectorLiteral(input.queryEmbedding)

  if (input.mode === 'semantic') {
    return {
      params: [
        embeddingStr,
        input.organizationId,
        input.userId,
        input.outputAudienceType,
        input.outputAudienceId,
        threshold,
        limit,
      ],
      sql: 'SELECT * FROM match_thoughts_scoped($1::vector, $2::uuid, $3::uuid, $4::"ThoughtAudienceType", $5::uuid, $6, $7)',
    }
  }

  if (input.mode === 'lexical') {
    return {
      params: [
        input.query,
        input.organizationId,
        input.userId,
        input.outputAudienceType,
        input.outputAudienceId,
        threshold,
        limit,
      ],
      sql: 'SELECT * FROM match_thoughts_lexical($1, $2::uuid, $3::uuid, $4::"ThoughtAudienceType", $5::uuid, $6, $7)',
    }
  }

  return {
    params: [
      embeddingStr,
      input.query,
      input.organizationId,
      input.userId,
      input.outputAudienceType,
      input.outputAudienceId,
      threshold,
      limit,
    ],
    sql: 'SELECT * FROM match_thoughts_hybrid($1::vector, $2, $3::uuid, $4::uuid, $5::"ThoughtAudienceType", $6::uuid, $7, $8)',
  }
}

export const searchThoughtCandidates = async (
  input: SearchThoughtCandidatesInput,
  db: Queryable,
): Promise<ThoughtSearchRow[]> => {
  const searchQuery = buildThoughtSearchQuery(input)
  const results = await db.query(searchQuery.sql, searchQuery.params)

  return results.rows as ThoughtSearchRow[]
}

export const searchThoughtCandidatesInScopes = async (
  input: SearchThoughtCandidatesInScopesInput,
  db: Queryable,
): Promise<ThoughtSearchRow[]> => {
  const threshold = input.threshold ?? 0.3
  const limit = input.limit ?? 10
  const results = await db.query(
    'SELECT * FROM match_thoughts_in_scopes($1::vector, $2, $3::uuid, $4::text[], $5::uuid[], $6::"ThoughtAudienceType", $7::uuid, $8::uuid, $9, $10)',
    [
      toVectorLiteral(input.queryEmbedding),
      input.query,
      input.organizationId,
      input.audienceTypes,
      input.audienceIds,
      input.currentAudienceType,
      input.currentAudienceId,
      input.runningAgentId,
      threshold,
      limit,
    ],
  )

  return results.rows as ThoughtSearchRow[]
}
