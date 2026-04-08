import type { ThoughtSearchMode } from '@nessie/schemas'
import type { Pool } from 'pg'
import type { RecallLogEntry } from './recalls.js'
import { getEmbedding, type EmbeddingConfig } from './embed.js'

type Queryable = Pick<Pool, 'query'>

export type SearchThoughtsInput = {
  query: string
  organizationId: string
  userId: string
  threshold?: number
  limit?: number
  includeReasoning?: boolean
  mode?: ThoughtSearchMode
  sessionId?: string
  channelId?: string
}

type ThoughtRow = {
  id: string
  content: string
  owner_type: string
  visibility: string
  importance: number
  metadata: unknown
  similarity: number
  created_at: string
}

type ReasoningRow = {
  thought_id: string
  reasoning_type: string
  alternatives: unknown
  criteria: unknown
  confidence: number
  reasoning: string
  outcome: string
  outcome_notes: string | null
}

export type SearchResult = {
  id: string
  content: string
  ownerType: string
  visibility: string
  importance: number
  metadata: unknown
  similarity: number
  createdAt: string
  rankPosition: number
  retrievalMode: ThoughtSearchMode
  recallId?: string
  reasoning?: {
    reasoningType: string
    alternatives: unknown
    criteria: unknown
    confidence: number
    reasoning: string
    outcome: string
    outcomeNotes: string | null
  }[]
}

export type SearchThoughtsOutput = {
  results: SearchResult[]
  recalls: RecallLogEntry[]
}

export type SearchConfig = {
  pool: Queryable
  embedding: EmbeddingConfig
}

type SearchQuerySpec = {
  sql: string
  params: unknown[]
}

export class SearchEmbeddingError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SearchEmbeddingError'
  }
}

const buildSearchQuery = (
  mode: ThoughtSearchMode,
  input: SearchThoughtsInput,
  queryEmbedding: number[] | null,
): SearchQuerySpec => {
  const threshold = input.threshold ?? 0.3
  const limit = input.limit ?? 10
  const embeddingStr = queryEmbedding ? `[${queryEmbedding.join(',')}]` : null

  if (mode === 'semantic') {
    return {
      sql: 'SELECT * FROM match_thoughts_scoped($1::vector, $2, $3, $4, $5)',
      params: [embeddingStr, input.organizationId, input.userId, threshold, limit],
    }
  }

  if (mode === 'lexical') {
    return {
      sql: 'SELECT * FROM match_thoughts_lexical($1, $2, $3, $4)',
      params: [input.query, input.organizationId, input.userId, limit],
    }
  }

  return {
    sql: 'SELECT * FROM match_thoughts_hybrid($1::vector, $2, $3, $4, $5, $6)',
    params: [embeddingStr, input.query, input.organizationId, input.userId, threshold, limit],
  }
}

const bumpThoughtAccess = async (
  thoughtIds: string[],
  db: Queryable,
): Promise<void> => {
  if (thoughtIds.length === 0) {
    return
  }

  await db.query(
    `UPDATE thoughts
     SET last_accessed_at = now(),
         access_count = access_count + 1,
         updated_at = now()
     WHERE id = ANY($1::uuid[])`,
    [thoughtIds],
  )
}

const mapThoughtRows = (
  rows: ThoughtRow[],
  mode: ThoughtSearchMode,
): SearchResult[] =>
  rows.map((thought, index) => ({
    id: thought.id,
    content: thought.content,
    ownerType: thought.owner_type,
    visibility: thought.visibility,
    importance: thought.importance,
    metadata: thought.metadata,
    similarity: thought.similarity,
    createdAt: String(thought.created_at),
    rankPosition: index + 1,
    retrievalMode: mode,
  }))

const buildRecallLogEntries = (
  results: SearchResult[],
  input: SearchThoughtsInput,
  queryEmbedding: number[] | null,
): RecallLogEntry[] =>
  results.map((result) => ({
    thoughtId: result.id,
    sessionId: input.sessionId,
    channelId: input.channelId,
    queryText: input.query,
    queryEmbedding,
    similarity: result.similarity,
    rankPosition: result.rankPosition,
    retrievalMode: result.retrievalMode,
  }))

const loadReasoningByThought = async (
  thoughtIds: string[],
  db: Queryable,
): Promise<Map<string, NonNullable<SearchResult['reasoning']>>> => {
  if (thoughtIds.length === 0) {
    return new Map()
  }

  const reasoningResults = await db.query(
    `SELECT thought_id, reasoning_type, alternatives, criteria, confidence,
            reasoning, outcome, outcome_notes
     FROM thought_reasonings
     WHERE thought_id = ANY($1)
     ORDER BY created_at ASC`,
    [thoughtIds],
  )

  const reasoningByThought = new Map<string, NonNullable<SearchResult['reasoning']>>()
  for (const row of reasoningResults.rows as ReasoningRow[]) {
    const reasoning = reasoningByThought.get(row.thought_id) ?? []
    reasoning.push({
      reasoningType: row.reasoning_type,
      alternatives: row.alternatives,
      criteria: row.criteria,
      confidence: row.confidence,
      reasoning: row.reasoning,
      outcome: row.outcome,
      outcomeNotes: row.outcome_notes,
    })
    reasoningByThought.set(row.thought_id, reasoning)
  }

  return reasoningByThought
}

export const searchThoughts = async (
  input: SearchThoughtsInput,
  config: SearchConfig,
): Promise<SearchThoughtsOutput> => {
  const mode = input.mode ?? 'hybrid'

  let queryEmbedding: number[] | null = null
  if (mode !== 'lexical') {
    try {
      queryEmbedding = await getEmbedding(input.query, config.embedding)
    } catch (err) {
      throw new SearchEmbeddingError(
        `Failed to embed search query: ${err instanceof Error ? err.message : 'unknown error'}`,
      )
    }
  }

  const searchQuery = buildSearchQuery(mode, input, queryEmbedding)
  const results = await config.pool.query(searchQuery.sql, searchQuery.params)
  const thoughts = results.rows as ThoughtRow[]
  const mappedResults = mapThoughtRows(thoughts, mode)
  const recalls = buildRecallLogEntries(mappedResults, input, queryEmbedding)

  await bumpThoughtAccess(
    mappedResults.map((result) => result.id),
    config.pool,
  )

  if (!input.includeReasoning || mappedResults.length === 0) {
    return { results: mappedResults, recalls }
  }

  const reasoningByThought = await loadReasoningByThought(
    mappedResults.map((result) => result.id),
    config.pool,
  )

  return {
    results: mappedResults.map((result) => ({
      ...result,
      reasoning: reasoningByThought.get(result.id),
    })),
    recalls,
  }
}
