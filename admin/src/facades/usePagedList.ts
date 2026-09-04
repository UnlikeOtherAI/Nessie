import { useCallback, useMemo } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useQuery, type UseQueryResult } from '@tanstack/react-query'
import {
  DEFAULT_PAGE_LIMIT,
  buildPageLabel,
  resolvePageSize,
  type PaginationMeta,
} from '@nessie/schemas'
import { paginationKeys } from '../lib/query-keys'
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

/**
 * The envelope as it arrives, `meta` intact.
 *
 * This reads through `api.getPage`, not `api.get`. `get` unwraps to
 * `payload.data`, which is correct for every call site that wants one record
 * or one array and silently wrong here — the cursors and the total live in
 * `meta`, and a list that lost them rendered empty with no next page.
 */
type PagedResponse<T> = {
  data: T
  meta?: PaginationMeta
}

type UsePagedListOptions<TData, TItem> = {
  /** Extract rows from an otherwise paged response. Arrays need no extractor. */
  items?: (data: TData) => TItem[]
  /**
   * Skips the fetch entirely, mirroring `useQuery`'s own option. An
   * owner-gated page renders its refusal without asking the server a question
   * it is going to decline.
   */
  enabled?: boolean
  /** Fallback before the URL chooses a page size. */
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

export type PagedList<T, TData = T[]> = {
  canNext: boolean
  canPrevious: boolean
  items: T[]
  /** "26–50 of 134" — ready for `PaginationFooter`. */
  label: string
  meta: PaginationMeta | undefined
  onPageChange: (page: number) => void
  onPageSizeChange: (pageSize: number) => void
  page: number
  pageCount: number
  pageSize: number
  query: UseQueryResult<PagedResponse<TData>>
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

export const usePagedList = <TItem, TData = TItem[]>({
  enabled = true,
  items: selectItems,
  limit: configuredLimit = DEFAULT_PAGE_LIMIT,
  params = {},
  paramPrefix = '',
  path,
  queryKey,
}: UsePagedListOptions<TData, TItem>): PagedList<TItem, TData> => {
  const api = useApiClient()
  const [searchParams, setSearchParams] = useSearchParams()

  const cursorKey = `${paramPrefix}cursor`
  const pageKey = `${paramPrefix}page`
  const directionKey = `${paramPrefix}direction`
  const limitKey = `${paramPrefix}limit`
  const cursor = searchParams.get(cursorKey) ?? undefined
  const savedLimit = Number(searchParams.get(limitKey))
  const limit = resolvePageSize(Number.isFinite(savedLimit) ? savedLimit : configuredLimit)
  const direction = searchParams.get(directionKey) === 'backward' ? 'backward' : 'forward'
  const page = Number(searchParams.get(pageKey) ?? '0') || 0

  // Serialised so the query key and the reset check both compare by value; two
  // objects with the same filters are the same page of the same list.
  const paramsKey = JSON.stringify(params)

  const query = useQuery({
    enabled,
    queryFn: () => api.getPage<TData>(`${path}${buildSearch({ ...params, direction }, cursor, limit)}`),
    queryKey: paginationKeys.page(queryKey, paramsKey, cursor, direction, limit),
  })

  const meta = query.data?.meta
  const items = useMemo(
    () => (query.data ? selectItems?.(query.data.data) ?? (query.data.data as unknown as TItem[]) : []),
    [query.data, selectItems],
  )
  // A keyset boundary may disappear between page loads. It is still a real
  // page in the URL, but there is no row from which the server can derive a
  // reverse cursor. Return to the first page explicitly instead of trapping
  // a person behind a disabled Previous control.
  const isStalePage = query.isSuccess && page > 0 && items.length === 0

  const onPageChange = useCallback(
    (next: number) => {
      // Cursors are opaque and only reach one page either way, so a jump of
      // more than one step is not expressible. `PaginationFooter` only ever
      // asks for ±1; anything else is a caller bug and is ignored rather than
      // silently landing on the wrong page.
      const forward = next > page
      if (!forward && isStalePage && next === page - 1) {
        setSearchParams(
          (current) => {
            const updated = new URLSearchParams(current)
            updated.delete(cursorKey)
            updated.delete(directionKey)
            updated.delete(pageKey)
            return updated
          },
          { replace: false },
        )
        return
      }
      const target = forward ? meta?.nextCursor : meta?.prevCursor
      if (Math.abs(next - page) !== 1 || !target) return

      setSearchParams(
        (current) => {
          const updated = new URLSearchParams(current)
          updated.set(cursorKey, target)
          updated.set(pageKey, String(Math.max(next, 0)))
          updated.set(directionKey, forward ? 'forward' : 'backward')
          return updated
        },
        { replace: false },
      )
    },
    [
      cursorKey,
      directionKey,
      meta?.nextCursor,
      meta?.prevCursor,
      isStalePage,
      page,
      pageKey,
      setSearchParams,
    ],
  )

  const onPageSizeChange = useCallback(
    (nextPageSize: number) => {
      const next = resolvePageSize(nextPageSize)
      if (next === limit) return

      setSearchParams(
        (current) => {
          const updated = new URLSearchParams(current)
          updated.set(limitKey, String(next))
          updated.delete(cursorKey)
          updated.delete(directionKey)
          updated.delete(pageKey)
          return updated
        },
        { replace: false },
      )
    },
    [cursorKey, directionKey, limit, limitKey, pageKey, setSearchParams],
  )

  const total = meta?.total
  const pageCount = Math.max(1, Math.ceil((total ?? items.length) / limit))

  return {
    canNext: Boolean(meta?.hasMore),
    canPrevious: Boolean(meta?.prevCursor) || isStalePage,
    items,
    label: buildPageLabel(meta ?? {}, page * limit, items.length),
    meta,
    onPageChange,
    onPageSizeChange,
    page,
    pageCount,
    pageSize: limit,
    query,
    total,
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
        updated.delete(`${paramPrefix}direction`)
        updated.delete(`${paramPrefix}page`)
        updated.delete(`${paramPrefix}limit`)
        return updated
      },
      { replace: true },
    )
  }, [paramPrefix, setSearchParams])
}
