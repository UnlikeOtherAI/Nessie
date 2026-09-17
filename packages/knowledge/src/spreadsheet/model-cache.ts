import { SPREADSHEET_LIMITS } from '@nessie/schemas'

import type { SpreadsheetWorkbook } from './engine.js'

/**
 * The per-process model cache. **A cache, never an authority**: it is consulted
 * only under the page's advisory lock and always fast-forwarded from the
 * journal first, so two replicas cannot disagree about a page's state. A
 * replica that never saw the page pays one `fromBytes` plus at most
 * `hotSnapshotEveryBatches` journal batches.
 *
 * Created once per process by the service factory as **closure state**, not
 * module scope: a module-level Map in `api/src` or `worker/src` is the thing
 * AGENTS.md bans, and it would also make two service instances in one test
 * share a cache and hide exactly the cross-replica bug the cache test exists
 * to catch.
 */

export type CachedSpreadsheetModel = {
  workbook: SpreadsheetWorkbook
  /** The journal seq this model stands at. */
  seq: number
  engineVersion: string
  /** Approximate resident size, from the last `toBytes()` this cache saw. */
  bytes: number
  lastUsedAt: number
}

export type SpreadsheetModelCache = {
  get: (pageId: string) => CachedSpreadsheetModel | null
  /** Record a model at a known seq, evicting by bytes and by idleness. */
  set: (pageId: string, entry: Omit<CachedSpreadsheetModel, 'lastUsedAt'>) => void
  /** Move an already-cached model forward after its batch committed. */
  commit: (pageId: string, seq: number, bytes?: number) => void
  evict: (pageId: string) => void
  clear: () => void
  /** Test and sweep surface: current entries and their total bytes. */
  stats: () => { entries: number; bytes: number }
}

export const createSpreadsheetModelCache = (
  options: { maxBytes?: number; idleMs?: number; now?: () => number } = {},
): SpreadsheetModelCache => {
  const maxBytes = options.maxBytes ?? SPREADSHEET_LIMITS.modelCacheMaxBytes
  const idleMs = options.idleMs ?? SPREADSHEET_LIMITS.modelCacheIdleMs
  const now = options.now ?? Date.now
  // Insertion order is recency order: every touch deletes and re-sets, so the
  // first key is always the least recently used.
  const entries = new Map<string, CachedSpreadsheetModel>()

  const totalBytes = (): number => {
    let total = 0
    for (const entry of entries.values()) total += entry.bytes
    return total
  }

  const dropIdle = (at: number): void => {
    for (const [pageId, entry] of entries) {
      if (at - entry.lastUsedAt >= idleMs) entries.delete(pageId)
    }
  }

  const dropOverBudget = (): void => {
    let total = totalBytes()
    for (const [pageId, entry] of entries) {
      if (total <= maxBytes) return
      entries.delete(pageId)
      total -= entry.bytes
    }
  }

  return {
    get: (pageId) => {
      const at = now()
      dropIdle(at)
      const entry = entries.get(pageId)
      if (!entry) return null
      entry.lastUsedAt = at
      entries.delete(pageId)
      entries.set(pageId, entry)
      return entry
    },
    set: (pageId, entry) => {
      const at = now()
      dropIdle(at)
      entries.delete(pageId)
      entries.set(pageId, { ...entry, lastUsedAt: at })
      dropOverBudget()
    },
    commit: (pageId, seq, bytes) => {
      const entry = entries.get(pageId)
      if (!entry) return
      entry.seq = seq
      entry.lastUsedAt = now()
      if (bytes !== undefined) entry.bytes = bytes
    },
    evict: (pageId) => {
      entries.delete(pageId)
    },
    clear: () => {
      entries.clear()
    },
    stats: () => ({ entries: entries.size, bytes: totalBytes() }),
  }
}
