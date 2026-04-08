import type { Pool } from 'pg'
import { getEmbedding, type EmbeddingConfig } from './embed.js'

export type SearchThoughtsInput = {
  query: string
  organizationId: string
  userId: string
  threshold?: number
  limit?: number
  includeReasoning?: boolean
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

export type SearchConfig = {
  pool: Pool
  embedding: EmbeddingConfig
}

export class SearchEmbeddingError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SearchEmbeddingError'
  }
}

export const searchThoughts = async (
  input: SearchThoughtsInput,
  config: SearchConfig,
): Promise<SearchResult[]> => {
  let queryEmbedding: number[]
  try {
    queryEmbedding = await getEmbedding(input.query, config.embedding)
  } catch (err) {
    throw new SearchEmbeddingError(
      `Failed to embed search query: ${err instanceof Error ? err.message : 'unknown error'}`,
    )
  }
  const embeddingStr = `[${queryEmbedding.join(',')}]`

  const threshold = input.threshold ?? 0.3
  const limit = input.limit ?? 10

  const results = await config.pool.query(
    `SELECT * FROM match_thoughts_scoped($1::vector, $2, $3, $4, $5)`,
    [embeddingStr, input.organizationId, input.userId, threshold, limit],
  )

  const thoughts = results.rows as ThoughtRow[]

  if (!input.includeReasoning) {
    return thoughts.map((t) => ({
      id: t.id,
      content: t.content,
      ownerType: t.owner_type,
      visibility: t.visibility,
      importance: t.importance,
      metadata: t.metadata,
      similarity: t.similarity,
      createdAt: String(t.created_at),
    }))
  }

  // Batch-load reasoning for all found thoughts
  const thoughtIds = thoughts.map((t) => t.id)
  if (thoughtIds.length === 0) {
    return []
  }

  const reasoningResults = await config.pool.query(
    `SELECT thought_id, reasoning_type, alternatives, criteria, confidence,
            reasoning, outcome, outcome_notes
     FROM thought_reasonings
     WHERE thought_id = ANY($1)
     ORDER BY created_at ASC`,
    [thoughtIds],
  )

  const reasoningByThought = new Map<string, NonNullable<SearchResult['reasoning']>>()
  for (const r of reasoningResults.rows as ReasoningRow[]) {
    const existing = reasoningByThought.get(r.thought_id) ?? []
    existing.push({
      reasoningType: r.reasoning_type,
      alternatives: r.alternatives,
      criteria: r.criteria,
      confidence: r.confidence,
      reasoning: r.reasoning,
      outcome: r.outcome,
      outcomeNotes: r.outcome_notes,
    })
    reasoningByThought.set(r.thought_id, existing)
  }

  return thoughts.map((t) => ({
    id: t.id,
    content: t.content,
    ownerType: t.owner_type,
    visibility: t.visibility,
    importance: t.importance,
    metadata: t.metadata,
    similarity: t.similarity,
    createdAt: String(t.created_at),
    reasoning: reasoningByThought.get(t.id),
  }))
}
