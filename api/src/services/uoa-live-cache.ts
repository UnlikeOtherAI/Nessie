import type { UoaSessionIdentity } from '@nessie/schemas'

/**
 * The one cache the relayed identity reads may use: bounded, process memory
 * only, short-lived, and never an authority.
 *
 * The sign-in provider owns people, teams and who is in which (AGENTS.md → UOA
 * identity authority), so Nessie stores none of it. A read that is relayed per
 * request may still be reused for a few seconds, under four rules this module
 * is the only place to state:
 *
 * - **Scoped to the asker.** A key names the organisation, the acting subject,
 *   their active team and their credential epoch (`liveCacheKey`). A new sign-in,
 *   a team switch or a revoked session is a different key, so nobody is served
 *   what somebody else's standing produced.
 * - **Never stale after a failure.** An expired entry is dropped before the
 *   upstream read; if that read fails, the failure is the answer.
 * - **Dropped by a write.** `invalidateOrganization` forgets every entry for an
 *   organisation and orphans any load already in flight, so a load that
 *   started before a roster change cannot put the old roster back.
 * - **Bounded.** A capped number of entries and a capped total weight (people,
 *   memberships), least recently used first out, and a cap on concurrent loads.
 */

export type LiveOrganizationCacheOptions<V> = {
  /** A cached value is handed out as a copy, so no caller can change it for the next. */
  copy: (value: V) => V
  maxEntries: number
  maxInFlight: number
  /** The total `weigh` the cache may hold before it evicts. */
  maxWeight: number
  now?: () => number
  /** The error a load refused for being one too many at once throws. */
  overloaded: () => Error
  ttlMs: number
  weigh: (value: V) => number
}

export type LiveOrganizationCache<V> = {
  read(key: string, externalOrgId: string, load: () => Promise<V>): Promise<V>
  invalidateOrganization(externalOrgId: string): void
}

type CacheEntry<V> = {
  expiresAt: number
  externalOrgId: string
  value: V
  weight: number
}

type InFlightEntry<V> = {
  externalOrgId: string
  invalidated: boolean
  promise: Promise<V>
}

/** The asker's scope: organisation, subject, active team and credential epoch, plus any narrowing. */
export const liveCacheKey = (
  externalOrgId: string,
  identity: Pick<UoaSessionIdentity, 'subject' | 'teamId' | 'tokenVersion'>,
  ...narrowing: string[]
): string => [
  externalOrgId,
  identity.subject,
  identity.teamId,
  identity.tokenVersion,
  ...narrowing,
].join('\u0000')

export const createLiveOrganizationCache = <V>(
  options: LiveOrganizationCacheOptions<V>,
): LiveOrganizationCache<V> => {
  const now = options.now ?? Date.now
  const cache = new Map<string, CacheEntry<V>>()
  const inFlight = new Map<string, InFlightEntry<V>>()
  const activeLoads = new Set<InFlightEntry<V>>()
  let cachedWeight = 0

  const deleteCached = (key: string): void => {
    const cached = cache.get(key)
    if (!cached) return
    cachedWeight -= cached.weight
    cache.delete(key)
  }

  const setCached = (key: string, externalOrgId: string, value: V): void => {
    // Replacement accounting is deliberate: a superseded request may finish
    // after a newer request for the same key has already populated the cache.
    deleteCached(key)
    const weight = options.weigh(value)
    cache.set(key, {
      expiresAt: now() + options.ttlMs,
      externalOrgId,
      value: options.copy(value),
      weight,
    })
    cachedWeight += weight
    while (cache.size > options.maxEntries || cachedWeight > options.maxWeight) {
      const oldest = cache.keys().next()
      if (oldest.done) break
      deleteCached(oldest.value)
    }
  }

  return {
    async read(key, externalOrgId, load) {
      const cached = cache.get(key)
      if (cached && cached.expiresAt > now()) {
        cache.delete(key)
        cache.set(key, cached)
        return options.copy(cached.value)
      }
      deleteCached(key)

      const currentLoad = inFlight.get(key)
      if (currentLoad) return options.copy(await currentLoad.promise)
      if (activeLoads.size >= options.maxInFlight) throw options.overloaded()

      // Defer the load until after the entry is registered. That closes the
      // synchronous invalidation window before the loader returns its promise.
      const entry: InFlightEntry<V> = {
        externalOrgId,
        invalidated: false,
        promise: Promise.resolve()
          .then(load)
          .then((value) => {
            if (!entry.invalidated) setCached(key, externalOrgId, value)
            return value
          })
          .finally(() => {
            activeLoads.delete(entry)
            if (inFlight.get(key) === entry) inFlight.delete(key)
          }),
      }
      inFlight.set(key, entry)
      activeLoads.add(entry)
      return options.copy(await entry.promise)
    },

    invalidateOrganization(externalOrgId) {
      for (const [key, entry] of cache) {
        if (entry.externalOrgId === externalOrgId) deleteCached(key)
      }
      for (const [key, entry] of inFlight) {
        if (entry.externalOrgId !== externalOrgId) continue
        entry.invalidated = true
        inFlight.delete(key)
      }
    },
  }
}
