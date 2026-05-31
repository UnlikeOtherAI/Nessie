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
) => {
  const hasMore = rows.length > limit
  const data = hasMore ? rows.slice(0, limit) : rows
  const last = data.at(-1)
  return {
    data,
    meta: {
      cursor: hasMore && last ? `${last.updatedAt}|${last.id}` : null,
      hasMore,
    },
  }
}
