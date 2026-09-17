// Client-side find over the mounted model.
//
// The pane searches the browser's own workbook — no round trip, so typing is
// instant (20 000 cells read in 12 ms on the spike box). Only *replace* goes
// through the route, so the change lands in the journal like any other batch.
import type { Model } from '@ironcalc/wasm'
import { columnIndexToLabel, type SpreadsheetSelection } from '@nessie/schemas'

export type FindOptions = {
  /** Search the formula text rather than the displayed value. */
  inFormulas: boolean
  matchCase: boolean
  query: string
  /** The pattern is a regular expression rather than a literal. */
  regex: boolean
  scope: 'range' | 'sheet' | 'workbook'
  selection?: SpreadsheetSelection
  /** The cell must equal the pattern, not merely contain it. */
  wholeCell: boolean
}

export type FindMatch = {
  a1: string
  column: number
  row: number
  sheet: number
  sheetName: string
  text: string
}

/** The plan's cap: a find box is a navigator, not a report. */
export const MAX_MATCHES = 200

/**
 * Builds the matcher. A malformed user regex is a typing state, not an error
 * screen, so it returns null and the caller shows "not a valid pattern".
 */
export const buildMatcher = (options: FindOptions): ((value: string) => boolean) | null => {
  if (!options.query) return null
  if (!options.regex) {
    if (options.wholeCell) {
      return options.matchCase
        ? (value) => value === options.query
        : (value) => value.toLowerCase() === options.query.toLowerCase()
    }
    return options.matchCase
      ? (value) => value.includes(options.query)
      : (value) => value.toLowerCase().includes(options.query.toLowerCase())
  }
  try {
    const source = options.wholeCell ? `^(?:${options.query})$` : options.query
    const pattern = new RegExp(source, options.matchCase ? 'u' : 'iu')
    return (value) => pattern.test(value)
  } catch {
    return null
  }
}

/** `undefined` means the pattern itself is not usable yet. */
export const findInModel = (
  model: Model,
  sheets: { index: number; name: string }[],
  activeSheet: number,
  options: FindOptions,
): FindMatch[] | undefined => {
  const matcher = buildMatcher(options)
  if (!matcher) return options.query ? undefined : []

  const searched = options.scope === 'workbook'
    ? sheets
    : sheets.filter((sheet) => sheet.index === activeSheet)
  const matches: FindMatch[] = []

  for (const sheet of searched) {
    // `getSheetDimensions` does not exist on the wasm binding (decisions.md
    // §"The two bindings are not structurally interchangeable"); the used range
    // is whatever `getRowsWithData` / `getColumnsWithData` report.
    const rows = options.scope === 'range' && options.selection
      ? rangeRows(options.selection)
      : Array.from(model.getRowsWithData(sheet.index, 1))
    for (const row of rows) {
      const columns = options.scope === 'range' && options.selection
        ? rangeColumns(options.selection)
        : Array.from(model.getColumnsWithData(sheet.index, row))
      for (const column of columns) {
        const text = options.inFormulas
          ? model.getCellContent(sheet.index, row, column)
          : model.getFormattedCellValue(sheet.index, row, column)
        if (!text || !matcher(text)) continue
        matches.push({
          a1: `${columnIndexToLabel(column)}${row}`,
          column,
          row,
          sheet: sheet.index,
          sheetName: sheet.name,
          text,
        })
        if (matches.length >= MAX_MATCHES) return matches
      }
    }
  }
  return matches
}

const rangeRows = (selection: SpreadsheetSelection): number[] =>
  Array.from({ length: selection.r1 - selection.r0 + 1 }, (_, index) => selection.r0 + index)

const rangeColumns = (selection: SpreadsheetSelection): number[] =>
  Array.from({ length: selection.c1 - selection.c0 + 1 }, (_, index) => selection.c0 + index)
