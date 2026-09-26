import { hashKey, type QueryClient, type QueryKey } from '@tanstack/react-query'
import { z } from 'zod'

export const READ_CACHE_KEY = 'nessie.read-cache.v1'
export const READ_CACHE_MAX_AGE = 24 * 60 * 60 * 1000
export const READ_CACHE_MAX_CHARS = 1_000_000
const MAX_ENTRIES = 60

const SnapshotSchema = z.object({
  version: z.literal(1),
  scope: z.string(),
  entries: z.array(z.object({
    key: z.array(z.unknown()),
    data: z.unknown(),
    updatedAt: z.number().finite().positive(),
  })).max(MAX_ENTRIES),
})
type Entry = z.infer<typeof SnapshotSchema>['entries'][number]
type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

/** A disk snapshot of selected React Query reads, never a second live store. */
export const createReadQueryCache = ({
  queryClient,
  storage,
  project,
  now = Date.now,
}: {
  queryClient: QueryClient
  storage: () => Store
  // An explicit allowlist also validates and strips unknown wire fields.
  project: (key: QueryKey, data: unknown) => unknown | undefined
  now?: () => number
}) => {
  let scope: string | null = null
  let timer: ReturnType<typeof setTimeout> | undefined
  let unsubscribe: (() => void) | undefined
  const remove = () => {
    try { storage().removeItem(READ_CACHE_KEY) } catch { /* Storage is optional. */ }
  }
  const cancelSave = () => {
    clearTimeout(timer)
    timer = undefined
  }
  const fresh = (at: number) => at <= now() && now() - at < READ_CACHE_MAX_AGE

  const flush = () => {
    cancelSave()
    if (!scope) return
    if (queryClient.isMutating()) { timer = setTimeout(flush, 1_000); return }
    try {
      const entries: Entry[] = []
      let size = JSON.stringify({ version: 1, scope, entries: [] }).length
      const queries = queryClient.getQueryCache().getAll()
        .sort((a, b) => b.state.dataUpdatedAt - a.state.dataUpdatedAt)
      for (const query of queries) {
        if (entries.length === MAX_ENTRIES) break
        const { dataUpdatedAt, data } = query.state
        // Keep the last result through background refreshes and transient
        // failures, preserving its original age. Mutations are fenced above.
        if (data === undefined || !fresh(dataUpdatedAt)) continue
        const projected = project(query.queryKey, data)
        if (projected === undefined) continue
        const entry = { key: [...query.queryKey], data: projected, updatedAt: dataUpdatedAt }
        const length = JSON.stringify(entry).length + 1
        if (size + length > READ_CACHE_MAX_CHARS) continue
        entries.push(entry)
        size += length
      }
      storage().setItem(READ_CACHE_KEY, JSON.stringify({ version: 1, scope, entries }))
    } catch {
      // Quota/private mode must never block navigation or retain an older file.
      remove()
    }
  }

  const start = () => {
    unsubscribe?.()
    unsubscribe = queryClient.getQueryCache().subscribe((event) => {
      if (!scope || (event.type !== 'updated' && event.type !== 'removed')) return
      if (event.type === 'updated' && event.action.type === 'error') {
        const error = event.query.state.error
        const status = error && 'status' in error ? error.status : undefined
        if (status === 401 || status === 403 || status === 404) {
          // An entitled read's refusal beats its old successful content.
          if (event.query.state.data !== undefined) {
            event.query.setState({ data: undefined, dataUpdatedAt: 0 })
          }
          flush()
          return
        }
      }
      // A throttle, not a debounce: busy realtime traffic cannot postpone it forever.
      if (!timer) timer = setTimeout(flush, 1_000)
    })
  }

  const activate = (nextScope: string) => {
    if (scope === nextScope) return
    cancelSave()
    scope = nextScope
    try {
      const raw = storage().getItem(READ_CACHE_KEY)
      if (!raw) return
      if (raw.length > READ_CACHE_MAX_CHARS) { remove(); return }
      const parsed = SnapshotSchema.safeParse(JSON.parse(raw))
      if (!parsed.success || parsed.data.scope !== scope) { remove(); return }
      for (const entry of parsed.data.entries) {
        if (!fresh(entry.updatedAt)) continue
        const data = project(entry.key, entry.data)
        if (data === undefined) continue
        const existing = queryClient.getQueryState(entry.key)
        if (existing && existing.dataUpdatedAt >= entry.updatedAt) continue
        queryClient.setQueryData(entry.key, data, { updatedAt: entry.updatedAt })
        // Including Infinity-stale queries: every restored read revalidates on mount.
        queryClient.getQueryCache().get(hashKey(entry.key))?.invalidate()
      }
    } catch { remove() }
  }

  return {
    activate,
    clear: () => { scope = null; cancelSave(); remove() },
    flush,
    start,
    stop: () => { flush(); cancelSave(); unsubscribe?.(); unsubscribe = undefined },
  }
}
