import {
  DEFAULT_PAGE_LIMIT,
  MAX_PAGE_LIMIT,
  PAGE_SIZE_OPTIONS,
  type PaginationDirection,
  type PaginationMeta,
} from './api.js'

export { PAGE_SIZE_OPTIONS }

/**
 * Keyset cursors, in one place.
 *
 * Five services independently wrote `${createdAt.toISOString()}|${id}` and
 * their own parser for it. The format is unchanged — this is the same string,
 * with one encoder and one decoder behind it — but it is **opaque to every
 * client**: it encodes the server's sort key, so a client that built or read
 * one would break the moment a list changed how it orders.
 *
 * Keyset rather than offset because rows are inserted while a person reads.
 * With `OFFSET 25`, one new row above the fold shifts everything down and page
 * two silently repeats a record page one already showed; with a keyset cursor
 * the boundary is a specific row, and it stays that row.
 */

export type KeysetCursor = {
  createdAt: Date
  id: string
}

export const encodeKeysetCursor = (row: KeysetCursor): string =>
  `${row.createdAt.toISOString()}|${row.id}`

export const decodeKeysetCursor = (cursor: string | undefined): KeysetCursor | null => {
  if (!cursor) return null

  const separator = cursor.indexOf('|')
  if (separator <= 0) return null

  const createdAt = new Date(cursor.slice(0, separator))
  const id = cursor.slice(separator + 1)
  if (Number.isNaN(createdAt.getTime()) || !id) return null

  return { createdAt, id }
}

/** Clamps a caller-supplied limit to the API's supported range. */
export const resolvePageLimit = (limit: number | undefined): number => {
  if (!limit || !Number.isFinite(limit)) return DEFAULT_PAGE_LIMIT
  return Math.min(Math.max(Math.trunc(limit), 1), MAX_PAGE_LIMIT)
}

/**
 * The only page sizes an admin person can choose. Unknown URL values resolve
 * to the default rather than producing a pager whose selected value is absent
 * from its control.
 */
export const resolvePageSize = (limit: number | undefined): number =>
  PAGE_SIZE_OPTIONS.includes(limit as typeof PAGE_SIZE_OPTIONS[number])
    ? limit ?? DEFAULT_PAGE_LIMIT
    : DEFAULT_PAGE_LIMIT

type BuildPageInput<T extends KeysetCursor> = {
  /** True when the caller supplied a cursor, i.e. this is not the first page. */
  hasCursor: boolean
  /**
   * A backward fetch reverses the database order to find the preceding page.
   * `buildPage` restores the canonical order and returns cursors that still
   * mean Previous and Next in that order.
   */
  direction?: PaginationDirection
  limit: number
  /** Exactly `limit + 1` rows when more exist — that extra row is how `hasMore` is known. */
  rows: T[]
  total?: number
}

/**
 * Turns an over-fetched row set into a page and its meta.
 *
 * The over-fetch (`take: limit + 1`) is the whole trick, and every service was
 * already doing it: one extra row answers "is there another page" without a
 * second query. This drops that row before returning.
 *
 * `prevCursor` is the **first** row of the page, so asking for it backwards
 * lands on the page before this one. It is null on the first page, which is
 * how the Previous control knows to disable itself.
 */
export const buildPage = <T extends KeysetCursor>({
  direction = 'forward',
  hasCursor,
  limit,
  rows,
  total,
}: BuildPageInput<T>): { data: T[]; meta: PaginationMeta } => {
  if (direction === 'backward') {
    const hasPrevious = rows.length > limit
    // The query is in reverse canonical order, so the first `limit` rows are
    // the preceding page and the extra row tells us whether it has a previous
    // neighbour. Reverse only after removing that over-fetched row.
    const data = rows.slice(0, limit).reverse()
    const first = data.at(0)
    const last = data.at(-1)

    return {
      data,
      meta: {
        // A backward request had to name the page it came from, so there is a
        // canonical next page whenever this result has rows.
        hasMore: Boolean(hasCursor && last),
        nextCursor: hasCursor && last ? encodeKeysetCursor(last) : null,
        prevCursor: hasPrevious && first ? encodeKeysetCursor(first) : null,
        ...(total === undefined ? {} : { total }),
      },
    }
  }

  const hasMore = rows.length > limit
  const data = hasMore ? rows.slice(0, limit) : rows
  const first = data.at(0)
  const last = data.at(-1)

  return {
    data,
    meta: {
      hasMore,
      nextCursor: hasMore && last ? encodeKeysetCursor(last) : null,
      prevCursor: hasCursor && first ? encodeKeysetCursor(first) : null,
      ...(total === undefined ? {} : { total }),
    },
  }
}

/**
 * The label under a paginated list: "26–50 of 134", or "26–50" when the
 * endpoint reports no total.
 *
 * It lives beside the meta rather than in the component because it is a
 * statement about the response, and because `PaginationFooter` deliberately
 * takes a string — a bare "Page 2" and a full range are true statements about
 * different amounts of knowledge.
 */
export const buildPageLabel = (
  meta: Pick<PaginationMeta, 'total'>,
  pageStart: number,
  pageCount: number,
): string => {
  if (pageCount === 0) return meta.total === undefined ? 'No results' : `0 of ${meta.total}`

  const range = `${pageStart + 1}–${pageStart + pageCount}`
  return meta.total === undefined ? range : `${range} of ${meta.total}`
}
