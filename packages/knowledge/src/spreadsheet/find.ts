import {
  SPREADSHEET_LIMITS,
  columnIndexToLabel,
  type SpreadsheetSelection,
} from '@nessie/schemas'
import type { SpreadsheetEngineModel } from '@nessie/spreadsheet'

/**
 * Find, and the match list a replace turns into a batch.
 *
 * TODO(Phase 1): `packages/spreadsheet/src/find.ts` owns this in the plan
 * (regex scope, the safe-regex helper, workbook scope with the lexer). This is
 * the narrow literal-match version the route and the replace batch need now;
 * delete it and import that one when it lands.
 */

export const SPREADSHEET_FIND_MAX_MATCHES = 200

export type SpreadsheetFindOptions = {
  matchCase?: boolean
  wholeCell?: boolean
  /** Search formula text rather than the value a person sees. */
  inFormulas?: boolean
  sheet?: number
  range?: SpreadsheetSelection
  limit?: number
}

export type SpreadsheetMatch = {
  sheet: number
  sheetName: string
  row: number
  column: number
  a1: string
  /** The cell's current content, so a replace knows what it is rewriting. */
  content: string
}

const matches = (haystack: string, needle: string, options: SpreadsheetFindOptions): boolean => {
  if (needle === '') return false
  const left = options.matchCase ? haystack : haystack.toLowerCase()
  const right = options.matchCase ? needle : needle.toLowerCase()
  return options.wholeCell ? left === right : left.includes(right)
}

export const findInWorkbook = (
  model: SpreadsheetEngineModel,
  query: string,
  options: SpreadsheetFindOptions = {},
): SpreadsheetMatch[] => {
  const limit = Math.min(options.limit ?? SPREADSHEET_FIND_MAX_MATCHES, SPREADSHEET_FIND_MAX_MATCHES)
  const sheets = model.sheets()
  const found: SpreadsheetMatch[] = []
  const indexes =
    options.sheet === undefined
      ? sheets.map((_, index) => index)
      : [options.sheet].filter((index) => index >= 0 && index < sheets.length)

  for (const sheet of indexes) {
    const [minRow, minColumn, maxRow, maxColumn] = model.dimensions(sheet)
    const r0 = Math.max(minRow, options.range?.r0 ?? minRow)
    const c0 = Math.max(minColumn, options.range?.c0 ?? minColumn)
    const r1 = Math.min(maxRow, options.range?.r1 ?? maxRow)
    const c1 = Math.min(maxColumn, options.range?.c1 ?? maxColumn)
    for (let row = r0; row <= r1; row++) {
      for (let column = c0; column <= c1; column++) {
        const content = model.cellContent(sheet, row, column) ?? ''
        const haystack = options.inFormulas
          ? content
          : model.formattedValue(sheet, row, column) ?? ''
        if (!matches(haystack, query, options)) continue
        found.push({
          sheet,
          sheetName: sheets[sheet]?.name ?? `Sheet${sheet + 1}`,
          row,
          column,
          a1: `${columnIndexToLabel(column)}${row}`,
          content,
        })
        if (found.length >= limit) return found
      }
    }
  }
  return found
}

/**
 * Replacement text for one match. `inFormulas` rewrites inside the formula
 * text; a result that no longer starts with `=` where the original did is
 * refused, because a broken formula silently becoming a text cell is the worst
 * outcome of a replace-all.
 */
export const replacementFor = (
  match: SpreadsheetMatch,
  query: string,
  replacement: string,
  options: SpreadsheetFindOptions,
): { value: string } | { refusedReason: string } => {
  const source = options.inFormulas
    ? match.content
    : match.content
  const pattern = options.matchCase ? query : query.toLowerCase()
  const next = options.wholeCell
    ? replacement
    : (() => {
        const haystack = options.matchCase ? source : source.toLowerCase()
        let out = ''
        let index = 0
        for (;;) {
          const at = haystack.indexOf(pattern, index)
          if (at === -1) {
            out += source.slice(index)
            break
          }
          out += source.slice(index, at) + replacement
          index = at + pattern.length
        }
        return out
      })()

  if (next.length > SPREADSHEET_LIMITS.maxCellTextChars) {
    return { refusedReason: 'the replacement would exceed the cell text limit' }
  }
  if (source.startsWith('=') && !next.startsWith('=')) {
    return { refusedReason: 'the replacement would turn a formula into text' }
  }
  return { value: next }
}
