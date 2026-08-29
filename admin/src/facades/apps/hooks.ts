import { useQuery } from '@tanstack/react-query'
import type {
  AppCategory,
  AppDetailRecord,
  AppListResponse,
} from '@nessie/schemas'
import { useApiClient } from '../../providers/ApiClientProvider'

/**
 * Domain facade for the member-facing app catalogue (`GET /api/apps`), backing
 * `/apps` and `/apps/:slug`.
 *
 * It deliberately does not overlap the `mcp-catalog` facade. That one speaks
 * the owner's governance vocabulary (status, visibility, lock, review queue)
 * and carries transport/auth config; this one speaks the member's ("app",
 * "connected account", "capability") and the server never puts an endpoint,
 * transport, or credential reference in its responses.
 *
 * `GET /api/apps/categories` has no hook here on purpose: `AppListResponse`
 * already carries the per-category counts the catalogue renders, so a second
 * request would only re-answer a question the first one answered.
 */

export type AppListFilters = {
  category?: AppCategory
  installed?: boolean
  query?: string
}

/**
 * Exported so the later connect phase can invalidate every catalogue read from
 * one place after an install, reconnect, or disconnect.
 */
export const APPS_QUERY_KEY = ['apps'] as const

const buildSearch = (filters: AppListFilters): string => {
  const params = new URLSearchParams()
  if (filters.query) params.set('query', filters.query)
  if (filters.category) params.set('category', filters.category)
  if (filters.installed) params.set('installed', 'true')
  const query = params.toString()
  return query ? `?${query}` : ''
}

/**
 * The whole catalogue the caller is entitled to see, in one request.
 *
 * The catalogue page passes no filters and narrows locally: browsing a store
 * must never wait on the network, and searching or flipping to "Installed"
 * against an already-loaded list is instant. The filter params exist because
 * the endpoint has them — a category deep-link or an embedded picker can ask
 * the server to narrow instead.
 */
export const useApps = (filters: AppListFilters = {}) => {
  const apiClient = useApiClient()
  const search = buildSearch(filters)

  return useQuery<AppListResponse>({
    // Searching re-fetches on every debounced keystroke. Without this the shelf
    // blanks to the pending state between queries, which reads as "no results"
    // for a moment on every letter.
    placeholderData: (previous) => previous,
    queryKey: [
      ...APPS_QUERY_KEY,
      'list',
      filters.query ?? null,
      filters.category ?? null,
      filters.installed ?? false,
    ],
    queryFn: () => apiClient.get(`/api/apps${search}`),
  })
}

/**
 * One app by its slug. `slug` is the route parameter, so it is optional here
 * and the query simply stays disabled until the router supplies one.
 */
export const useApp = (slug: string | undefined) => {
  const apiClient = useApiClient()

  return useQuery<AppDetailRecord>({
    queryKey: [...APPS_QUERY_KEY, 'detail', slug ?? null],
    queryFn: () => apiClient.get(`/api/apps/${encodeURIComponent(slug ?? '')}`),
    enabled: Boolean(slug),
  })
}
