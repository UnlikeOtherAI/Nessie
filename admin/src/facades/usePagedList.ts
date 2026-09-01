import { useCallback, useMemo } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useQuery, type UseQueryResult } from '@tanstack/react-query'
import {
  DEFAULT_PAGE_LIMIT,
  buildPageLabel,
  type PaginationMeta,
} from '@nessie/schemas'
import { useApiClient } from '../providers/ApiClientProvider'

/**
 * One way to read a paged list, for every list in the admin.
 *
 * Four surfaces used `PaginationFooter`, two hand-rolled a "Load more", one
 * wrote its own Previous/Next strip, and everything else simply rendered
 * whatever the first `limit` rows happened to be with no way to reach the
 * rest. This hook and `PaginationFooter` are now the whole story.
 *
 * **The cursor lives in the URL.** A person who pages to the third screen of
 * an audit log and reloads, or opens a row and presses Back, should still be
 * on the third screen; page state held in a component is lost by both.
 */

type PagedResponse<T> = {
  data: T[]
  meta: PaginationMeta
}

type UsePagedListOptions = {
  /** Page size. The one place it is chosen; there is no per-user control. */
  limit?: number
  /**
   * Filters, search and sort, already resolved by the caller. Changing any of
   * them returns to the first page — a cursor names a row in the previous
   * result set and means nothing in the new one.
   */
  params?: Record<string, string | undefined>
  /**
   * Distinguishes this list's URL parameters when a page shows two paged
   * lists. Defaults to unprefixed, which is what a page with one list wants.
   */
  paramPrefix?: string
  /** Path without a query string, e.g. `/api/audit`. */
  path: string
  /** React Query key. The resolved query string is appended automatically. */
  queryKey: readonly unknown[]
}

export type PagedList<T> = {
  canNext: boolean
  canPrevious: boolean
  items: T[]
  /** "26–50 of 134" — ready for `PaginationFooter`. */
  label: string
  meta: PaginationMeta | undefined
  onPageChange: (page: number) => void
  page: number
  query: UseQueryResult<PagedResponse<T>>
  /** The server's count of matching records, for a `ListToolbar`. */
  total: number | undefined
}

const buildSearch = (
  params: Record<string, string | undefined>,
  cursor: string | undefined,
  limit: number,
): string => {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') search.set(key, value)
  }
  search.set('limit', String(limit))
  if (cursor) search.set('cursor', cursor)
  return `?${search.toString()}`
}

export const usePagedList = <T>({
  limit = DEFAULT_PAGE_LIMIT,
  params = {},
  paramPrefix = '',
  path,
  queryKey,
}: UsePagedListOptions): PagedList<T> => {
  const api = useApiClient()
  const [searchParams, setSearchParams] = useSearchParams()

  const cursorKey = `${paramPrefix}cursor`
  const pageKey = `${paramPrefix}page`
  const cursor = searchParams.get(cursorKey) ?? undefined
  const page = Number(searchParams.get(pageKey) ?? '0') || 0

  // Serialised so the query key and the reset check both compare by value; two
  // objects with the same filters are the same page of the same list.
  const paramsKey = JSON.stringify(params)

  const query = useQuery({
    queryFn: () => api.get<PagedResponse<T>>(`${path}${buildSearch(params, cursor, limit)}`),
    queryKey: [...queryKey, paramsKey, cursor ?? null, limit],
  })

  const meta = query.data?.meta

  const onPageChange = useCallback(
    (next: number) => {
      // Cursors are opaque and only reach one page either way, so a jump of
      // more than one step is not expressible. `PaginationFooter` only ever
      // asks for ±1; anything else is a caller bug and is ignored rather than
      // silently landing on the wrong page.
      const forward = next > page
      const target = forward ? meta?.nextCursor : meta?.prevCursor
      if (Math.abs(next - page) !== 1 || !target) return

      setSearchParams(
        (current) => {
          const updated = new URLSearchParams(current)
          updated.set(cursorKey, target)
          updated.set(pageKey, String(Math.max(next, 0)))
          return updated
        },
        { replace: true },
      )
    },
    [cursorKey, meta?.nextCursor, meta?.prevCursor, page, pageKey, setSearchParams],
  )

  const items = useMemo(() => query.data?.data ?? [], [query.data])

  return {
    canNext: Boolean(meta?.hasMore),
    canPrevious: Boolean(meta?.prevCursor),
    items,
    label: buildPageLabel(meta ?? {}, page * limit, items.length),
    meta,
    onPageChange,
    page,
    query,
    total: meta?.total,
  }
}

/**
 * Clears a list's page state, for a caller whose filters just changed.
 *
 * It is the caller's call rather than an effect in the hook: a filter change
 * and a params-object identity change look identical from in here, and
 * resetting on the latter would send a list back to page one every time its
 * parent re-rendered.
 */
export const usePagedListReset = (paramPrefix = ''): (() => void) => {
  const [, setSearchParams] = useSearchParams()

  return useCallback(() => {
    setSearchParams(
      (current) => {
        const updated = new URLSearchParams(current)
        updated.delete(`${paramPrefix}cursor`)
        updated.delete(`${paramPrefix}page`)
        return updated
      },
      { replace: true },
    )
  }, [paramPrefix, setSearchParams])
}
