import type { LedgerAttribution, ModelClient } from '@nessie/runtime'

// Short-lived cache for hybrid search's query-embedding step: repeated
// searches for the same (model, normalized query) within a short window reuse
// the vector instead of re-billing an embed call per keystroke-driven search.
const CACHE_TTL_MS = 15 * 60 * 1000
const MAX_CACHE_ENTRIES = 500

type CacheEntry = {
  embedding: number[]
  expiresAt: number
}

const cache = new Map<string, CacheEntry>()

const cacheKey = (model: string, query: string): string =>
  `${model}:${query.trim().toLowerCase()}`

const readCache = (key: string): number[] | null => {
  const entry = cache.get(key)
  if (!entry) return null
  if (entry.expiresAt <= Date.now()) {
    cache.delete(key)
    return null
  }
  return entry.embedding
}

const writeCache = (key: string, embedding: number[]): void => {
  // Refresh insertion order so the true least-recently-written entry is
  // evicted first once the cache is full.
  cache.delete(key)
  cache.set(key, { embedding, expiresAt: Date.now() + CACHE_TTL_MS })
  if (cache.size > MAX_CACHE_ENTRIES) {
    const oldestKey = cache.keys().next().value
    if (oldestKey !== undefined) cache.delete(oldestKey)
  }
}

// Resolves the embedding vector for a hybrid search query, caching by
// normalized (model, query) for CACHE_TTL_MS. Returns null (never throws) when
// there is no model client or the embed call fails, so callers can fall back
// to the lexical-only channel of hybrid search.
export const getQueryEmbedding = async (
  modelClient: ModelClient | null,
  query: string,
  usage: LedgerAttribution,
): Promise<number[] | null> => {
  if (!modelClient) return null
  const key = cacheKey(modelClient.embeddingModel, query)
  const cached = readCache(key)
  if (cached) return cached
  try {
    const embedding = await modelClient.embed(query, { usage })
    writeCache(key, embedding)
    return embedding
  } catch (error) {
    console.warn('knowledge hybrid search: query embedding failed', error)
    return null
  }
}
