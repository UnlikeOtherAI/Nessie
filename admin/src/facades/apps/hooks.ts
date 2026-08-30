import { useInfiniteQuery, useQuery } from '@tanstack/react-query'
import type {
  AppCategory,
  AppDetailRecord,
  AppListResponse,
} from '@nessie/schemas'
import { appKeys } from '../../lib/query-keys'
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
  offset?: number
}

/**
 * The catalogue family's invalidation prefix, so the connect and agent-access
 * hooks can refresh every catalogue read from one place after an install,
 * reconnect, or disconnect.
 *
 * It is the shared factory's root rather than its own `['apps']` literal: a
 * second spelling of a prefix stops matching the moment either side moves,
 * which is the drift `lib/query-keys.ts` exists to remove.
 */
export const APPS_QUERY_KEY = appKeys.all

const buildSearch = (filters: AppListFilters): string => {
  const params = new URLSearchParams()
  if (filters.query) params.set('query', filters.query)
  if (filters.category) params.set('category', filters.category)
  if (filters.installed) params.set('installed', 'true')
  if (filters.offset) params.set('offset', String(filters.offset))
  const query = params.toString()
  return query ? `?${query}` : ''
}

/** Normalised so two spellings of the same request share one cache entry. */
const normalise = (filters: AppListFilters): AppListFilters => ({
  category: filters.category,
  installed: filters.installed === true,
  offset: filters.offset,
  query: filters.query?.trim() ?? '',
})

/**
 * A catalogue response **together with the request it answers**.
 *
 * This pairing is the whole point of the type. `placeholderData` keeps the
 * previous results painted while the next ones load — without it every
 * keystroke blanks the shelf — but that means the rendered rows can belong to
 * an *older* query than the one in component state. Labelling those rows with
 * the new query ("12 results for git") or deciding an empty state from it ("No
 * apps match git") describes a request the server has not answered yet, which
 * is how a page ends up asserting something untrue about data it is showing.
 * Read the narration off `applied`, never off the input the caller last typed.
 */
export type AppCataloguePage = {
  applied: AppListFilters
  response: AppListResponse
}

/**
 * One bounded page of the catalogue.
 *
 * The response is a slice by construction — the featured strip plus a shelf per
 * category, or one category's page, or a search's top results — while the
 * counts it carries (`totalCount`, `installedCount`, `categories[].count`) are
 * server-side aggregates over the unsliced set. So filters go to the *server*:
 * "Installed" is a narrowing of the whole catalogue, and applying it to a
 * loaded slice would both hide apps the caller has connected and disagree with
 * the count printed on the control that applied it. The query goes to the
 * server for the same reason it always did — Postgres owns the weighted ranking
 * and the typo fallback, and the client filters nothing and re-sorts nothing.
 */
export const useApps = (filters: AppListFilters = {}) => {
  const apiClient = useApiClient()
  const applied = normalise(filters)
  const search = buildSearch(applied)

  return useQuery<AppCataloguePage>({
    // Searching re-fetches on every debounced keystroke. Without this the shelf
    // blanks to the pending state between queries, which reads as "no results"
    // for a moment on every letter. `applied` is what keeps the copy honest
    // while that older page is on screen.
    placeholderData: (previous) => previous,
    queryKey: appKeys.list(applied),
    queryFn: async () => ({
      applied,
      response: await apiClient.get<AppListResponse>(`/api/apps${search}`),
    }),
  })
}

/**
 * The rest of one category, a page at a time.
 *
 * A category can hold hundreds of apps once the registry has been ingested, so
 * "Show all" fetches rather than expands: the page never holds more cards than
 * a person asked to see. No page size is sent — the server owns that number,
 * and a second opinion here would drift from it.
 *
 * `getNextPageParam` measures progress against `categories[].count`, the SQL
 * total for this category under the same narrowing, so "there is more" is a
 * fact from the database rather than an inference from a full-looking page.
 */
export const useAppCategoryPages = (input: {
  category: AppCategory
  enabled: boolean
  installed: boolean
}) => {
  const apiClient = useApiClient()

  return useInfiniteQuery({
    enabled: input.enabled,
    initialPageParam: 0,
    queryKey: appKeys.category(input.category, input.installed),
    queryFn: ({ pageParam }): Promise<AppListResponse> =>
      apiClient.get<AppListResponse>(
        `/api/apps${buildSearch({
          category: input.category,
          installed: input.installed,
          offset: pageParam,
        })}`,
      ),
    getNextPageParam: (lastPage: AppListResponse, allPages: AppListResponse[]) => {
      const loaded = allPages.reduce((sum, page) => sum + page.apps.length, 0)
      const total =
        lastPage.categories.find((entry) => entry.category === input.category)?.count ?? 0
      // A page that came back empty ends the walk even if the count disagrees,
      // so a row deleted mid-scroll cannot spin the loader forever.
      return lastPage.apps.length > 0 && loaded < total ? loaded : undefined
    },
  })
}

/**
 * One app by its slug. `slug` is the route parameter, so it is optional here
 * and the query simply stays disabled until the router supplies one.
 */
export const useApp = (slug: string | undefined) => {
  const apiClient = useApiClient()

  return useQuery<AppDetailRecord>({
    queryKey: appKeys.detail(slug),
    queryFn: () => apiClient.get(`/api/apps/${encodeURIComponent(slug ?? '')}`),
    enabled: Boolean(slug),
  })
}
