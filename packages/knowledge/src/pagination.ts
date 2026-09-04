export const DEFAULT_LIMIT = 50
export const MAX_LIMIT = 200

export const clampLimit = (limit?: number): number =>
  Math.min(Math.max(limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT)

export type ParsedCursor = {
  cursorDate: Date
  cursorId: string
}

export const parseCursor = (raw?: string): ParsedCursor | null => {
  if (!raw) return null
  const [isoPart, idPart] = raw.split('|')
  if (!isoPart || !idPart) return null
  const cursorDate = new Date(isoPart)
  if (Number.isNaN(cursorDate.getTime())) return null
  return { cursorDate, cursorId: idPart }
}

export const encodeCursor = (updatedAt: Date, id: string): string =>
  `${updatedAt.toISOString()}|${id}`

export const trimPage = <T extends { id: string; updatedAt: string }>(
  rows: T[],
  limit: number,
  options?: { cursor?: string; direction?: 'forward' | 'backward'; hasCursor: boolean },
) => {
  if (options?.direction === 'backward') {
    const hasPrevious = rows.length > limit
    const data = rows.slice(0, limit).reverse()
    const first = data.at(0)
    const last = data.at(-1)
    return {
      data,
      meta: {
        cursor: options.hasCursor && last ? `${last.updatedAt}|${last.id}` : null,
        hasMore: Boolean(options.hasCursor && last),
        previousCursor: hasPrevious && first ? `${first.updatedAt}|${first.id}` : null,
      },
    }
  }
  const hasMore = rows.length > limit
  const data = hasMore ? rows.slice(0, limit) : rows
  const last = data.at(-1)
  const first = data.at(0)
  return {
    data,
    meta: {
      cursor: hasMore && last ? `${last.updatedAt}|${last.id}` : null,
      hasMore,
      ...(options ? {
        // A deleted boundary can leave a once-valid cursor with no rows. Keep
        // the original boundary as a server-side fallback; clients that know
        // their local page is stale reset to the first page rather than
        // trapping a person on an empty URL.
        previousCursor: options.hasCursor
          ? first ? `${first.updatedAt}|${first.id}` : options.cursor ?? null
          : null,
      } : {}),
    },
  }
}
