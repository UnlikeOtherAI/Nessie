import type { LedgerAttribution, ModelClient } from '@nessie/runtime'

// Short-lived cache for hybrid search's query-embedding step: autocomplete can
// ask several result providers about the same normalized query, and they must
// share one billed embedding rather than each calling the model independently.
const CACHE_TTL_MS = 15 * 60 * 1000
const MAX_CACHE_ENTRIES = 500

type CacheEntry = {
  embedding: number[]
  expiresAt: number
}

// Read-through only, bounded by size and TTL; never used as search authority.
// eslint-disable-next-line no-restricted-syntax
const cache = new Map<string, CacheEntry>()
// Request coalescing only, bounded by MAX_CACHE_ENTRIES and model-call lifetime.
// eslint-disable-next-line no-restricted-syntax
const inFlight = new Map<string, Promise<number[] | null>>()

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
  cache.delete(key)
  cache.set(key, { embedding, expiresAt: Date.now() + CACHE_TTL_MS })
  if (cache.size > MAX_CACHE_ENTRIES) {
    const oldestKey = cache.keys().next().value
    if (oldestKey !== undefined) cache.delete(oldestKey)
  }
}

/**
 * Resolve one query vector for every hybrid search provider. Returns `null`
 * rather than throwing when embeddings are unavailable, so each provider can
 * continue through its lexical arm and autocomplete never becomes model-only.
 */
export const getQueryEmbedding = async (
  modelClient: ModelClient | null,
  query: string,
  usage: LedgerAttribution,
): Promise<number[] | null> => {
  if (!modelClient) return null
  const key = cacheKey(modelClient.embeddingModel, query)
  const cached = readCache(key)
  if (cached) return cached
  const existing = inFlight.get(key)
  if (existing) return existing

  const resolve = async (): Promise<number[] | null> => {
    try {
      const embedding = await modelClient.embed(query, { usage })
      writeCache(key, embedding)
      return embedding
    } catch (error) {
      console.warn('hybrid search: query embedding failed', error)
      return null
    }
  }
  if (inFlight.size >= MAX_CACHE_ENTRIES) return resolve()

  const pending = resolve()
  inFlight.set(key, pending)
  try {
    return await pending
  } finally {
    if (inFlight.get(key) === pending) inFlight.delete(key)
  }
}
