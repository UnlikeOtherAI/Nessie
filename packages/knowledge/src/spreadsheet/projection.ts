import type { SpreadsheetEngineModel } from '@nessie/spreadsheet'

/**
 * The text projection a durable version stores in `KnowledgePageVersion.body`,
 * so a spreadsheet is chunked, embedded and searchable by exactly the code
 * every other page kind uses (`indexVersionChunks`) — no new indexing path.
 *
 * TODO(Phase 1): `packages/spreadsheet/src/projection.ts` owns this in the
 * plan. This is the narrow version the version writer needs now; delete it and
 * import that one when it lands. The shape is the plan's: per sheet a
 * `## <name>` heading, then rows of formatted values tab-separated inside the
 * used range, trailing blanks trimmed, capped with a marker.
 */

export const PROJECTION_MAX_CHARS = 200_000

export const projectWorkbookText = (
  model: SpreadsheetEngineModel,
  options: { maxChars?: number } = {},
): string => {
  const maxChars = options.maxChars ?? PROJECTION_MAX_CHARS
  const parts: string[] = []
  let length = 0
  let truncated = false

  const push = (line: string): boolean => {
    if (length + line.length + 1 > maxChars) {
      truncated = true
      return false
    }
    parts.push(line)
    length += line.length + 1
    return true
  }

  const sheets = model.sheets()
  outer: for (let sheet = 0; sheet < sheets.length; sheet++) {
    if (!push(`## ${sheets[sheet]?.name ?? `Sheet${sheet + 1}`}`)) break
    const [minRow, minColumn, maxRow, maxColumn] = model.dimensions(sheet)
    for (let row = minRow; row <= maxRow; row++) {
      const cells: string[] = []
      for (let column = minColumn; column <= maxColumn; column++) {
        cells.push(model.formattedValue(sheet, row, column) ?? '')
      }
      while (cells.length > 0 && cells[cells.length - 1] === '') cells.pop()
      if (cells.length === 0) continue
      if (!push(cells.join('\t'))) break outer
    }
  }

  if (truncated) parts.push('… (projection truncated)')
  return parts.join('\n')
}
