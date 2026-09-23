import { useCallback, useMemo } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useQuery, type UseQueryResult } from '@tanstack/react-query'
import {
  DEFAULT_PAGE_LIMIT,
  buildPageLabel,
  resolvePageSize,
  type PaginationMeta,
} from '@nessie/schemas'
import type { ApiResponseDataSchema } from '@nessie/client-core'
import { paginationKeys } from '../../lib/query-keys'
import { useApiClient } from '../../providers/ApiClientProvider'
import {
  firstPageParams,
  pagedListParamNames,
  trailBackwardParams,
  trailForwardParams,
  trailPageLabel,
} from './cursor-trail'

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
  /**
   * How Previous finds the page before this one. `server` (the default) asks
   * the server backwards from its `prevCursor`. `trail` is for a list the
   * server can only page forwards — one it filters row by row for the viewer,
   * which returns no `prevCursor` — and keeps the cursors already walked
   * through in the URL instead (`cursor-trail.ts`). Such a list's pages may be
   * short, or empty, while `hasMore` is true, so its label counts the rows on
   * the page rather than claiming a range.
   */
  backward?: 'server' | 'trail'
  /** Extract rows from an otherwise paged response. Arrays need no extractor. */
  items?: (data: TData) => TItem[]
  /**
   * Read the cursors from inside `data`, for a list whose contract carries
   * `{items, meta}` as its data (the DeepWater research list) rather than
   * `meta` beside it. Absent, `meta` is read from the envelope.
   */
  meta?: (data: TData) => PaginationMeta
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
  /** Identifies the record a prefixed cursor belongs to, when one screen switches records. */
  scope?: string
  /** Path without a query string, e.g. `/api/audit`. */
  path: string
  /**
   * The page's `data` contract. A body that does not match fails as the
   * query's error (`INVALID_RESPONSE`) instead of reaching the rows, which
   * would otherwise render whatever arrived as if it were the list.
   */
  schema?: ApiResponseDataSchema<TData>
  /** React Query key. The resolved query string is appended automatically. */
  queryKey: readonly unknown[]
}

export type PagedList<T, TData = T[]> = {
  canNext: boolean
  canPrevious: boolean
  items: T[]
  /** "26–50 of 134" — ready for `PaginationFooter`; "7 on this page" for a `trail` list. */
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
  backward = 'server',
  enabled = true,
  items: selectItems,
  limit: configuredLimit = DEFAULT_PAGE_LIMIT,
  meta: selectMeta,
  params = {},
  paramPrefix = '',
  scope,
  path,
  queryKey,
  schema,
}: UsePagedListOptions<TData, TItem>): PagedList<TItem, TData> => {
  const api = useApiClient()
  const [searchParams, setSearchParams] = useSearchParams()

  const paramNames = useMemo(() => pagedListParamNames(paramPrefix), [paramPrefix])
  const { cursor: cursorKey, direction: directionKey, page: pageKey, scope: scopeKey } = paramNames
  const limitKey = `${paramPrefix}limit`
  const scopeMatches = !scope || searchParams.get(scopeKey) === scope
  const cursor = scopeMatches ? searchParams.get(cursorKey) ?? undefined : undefined
  // An absent parameter is `Number(null)`, i.e. 0, which is finite: reading it
  // as a saved size silently replaced every caller's configured limit with 25.
  const savedLimit = searchParams.get(limitKey)
  const limit = resolvePageSize(savedLimit === null ? configuredLimit : Number(savedLimit))
  const trailed = backward === 'trail'
  const direction = !trailed && scopeMatches && searchParams.get(directionKey) === 'backward' ? 'backward' : 'forward'
  const page = scopeMatches ? Number(searchParams.get(pageKey) ?? '0') || 0 : 0

  // Serialised so the query key and the reset check both compare by value; two
  // objects with the same filters are the same page of the same list.
  const paramsKey = JSON.stringify(params)

  const query = useQuery({
    enabled,
    queryFn: () => api.getPage<TData>(`${path}${buildSearch({ ...params, direction }, cursor, limit)}`, schema),
    queryKey: paginationKeys.page(queryKey, paramsKey, cursor, direction, limit),
  })

  const meta = query.data
    ? selectMeta ? selectMeta(query.data.data) : query.data.meta
    : undefined
  const items = useMemo(
    () => (query.data ? selectItems?.(query.data.data) ?? (query.data.data as unknown as TItem[]) : []),
    [query.data, selectItems],
  )
  // A keyset boundary may disappear between page loads. It is still a real
  // page in the URL, but there is no row from which the server can derive a
  // reverse cursor. Return to the first page explicitly instead of trapping
  // a person behind a disabled Previous control.
  const isStalePage = query.isSuccess
    && page > 0
    && items.length === 0
    && !meta?.prevCursor

  const onPageChange = useCallback(
    (next: number) => {
      // Cursors are opaque and only reach one page either way, so a jump of
      // more than one step is not expressible. `PaginationFooter` only ever
      // asks for ±1; anything else is a caller bug and is ignored rather than
      // silently landing on the wrong page.
      const forward = next > page
      if (trailed) {
        const nextCursor = meta?.nextCursor
        if (Math.abs(next - page) !== 1 || (forward && !nextCursor)) return
        setSearchParams(
          (current) => {
            // A cursor from another record's list starts a walk of its own.
            const base = scope && current.get(scopeKey) !== scope ? firstPageParams(current, paramNames) : current
            return forward && nextCursor
              ? trailForwardParams(base, paramNames, { cursor: nextCursor, page: next, scope })
              : trailBackwardParams(base, paramNames, page)
          },
          { replace: false },
        )
        return
      }
      if (!forward && isStalePage && next === page - 1) {
        setSearchParams((current) => firstPageParams(current, paramNames), { replace: false })
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
          if (scope) updated.set(scopeKey, scope)
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
      paramNames,
      page,
      pageKey,
      setSearchParams,
      scope,
      scopeKey,
      trailed,
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
          if (scope) updated.set(scopeKey, scope)
          return firstPageParams(updated, paramNames)
        },
        { replace: false },
      )
    },
    [paramNames, limit, limitKey, scope, scopeKey, setSearchParams],
  )

  const total = meta?.total
  // A count is intentionally absent from disclosure-filtered history. Keep
  // the footer's page position truthful without inventing a terminal page:
  // when another cursor exists, the next page is known to exist; otherwise
  // this current page is the end of the walk.
  const pageCount = total === undefined
    ? Math.max(1, page + (meta?.hasMore ? 2 : 1))
    : Math.max(1, Math.ceil(total / limit))

  return {
    canNext: Boolean(meta?.hasMore),
    canPrevious: trailed ? page > 0 : Boolean(meta?.prevCursor) || isStalePage,
    items,
    // A forward-only list's pages vary in length, so `page * limit` is not
    // where this page starts: it says only how many rows it holds.
    label: trailed ? trailPageLabel(items.length) : buildPageLabel(meta ?? {}, page * limit, items.length),
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
        const updated = firstPageParams(current, pagedListParamNames(paramPrefix))
        updated.delete(`${paramPrefix}limit`)
        updated.delete(`${paramPrefix}scope`)
        return updated
      },
      { replace: true },
    )
  }, [paramPrefix, setSearchParams])
}
