import { SPREADSHEET_LIMITS, selectionCellCount, type SpreadsheetSelection, type SpreadsheetSheetInfo } from '@nessie/schemas'

import { cellA1, clampRange, formatA1Range, tooLarge } from './a1.js'
import type { SpreadsheetEngineModel } from './engine.js'

// Reads. Everything here is bounded by `maxCellsPerRead`: a caller either asks
// for a range that fits, or says `clamp` and gets the first page with
// `truncated: true`. Nothing in this module walks a sheet unbounded — a
// spreadsheet is the one kind where "just read it all" is a 17-billion-cell
// address space.

export interface ReadRangeOptions {
  /** Formatted values (`"$ 5.75"`). On by default. */
  values?: boolean
  /** Cell contents — the formula text for a formula cell. Off by default. */
  formulas?: boolean
  /** Cell type codes (1 number, 2 text, 4 boolean, 16 error, …). Off by default. */
  types?: boolean
  /** Clip to the cap instead of refusing an over-large range. */
  clamp?: boolean
  max?: number
}

export interface ReadRangeResult {
  sheet: number
  sheetName: string
  range: SpreadsheetSelection
  a1: string
  rowCount: number
  columnCount: number
  /** Row-major, `rows[r][c]`, `''` for an empty cell. */
  values?: string[][]
  formulas?: string[][]
  types?: number[][]
  truncated: boolean
}

function sheetName(model: SpreadsheetEngineModel, sheet: number): string {
  return model.sheets()[sheet]?.name ?? `Sheet${sheet + 1}`
}

export function readRange(
  model: SpreadsheetEngineModel,
  sheet: number,
  range: SpreadsheetSelection,
  options: ReadRangeOptions = {},
): ReadRangeResult {
  const max = options.max ?? SPREADSHEET_LIMITS.maxCellsPerRead
  const count = selectionCellCount(range)
  if (count > max && !options.clamp) {
    throw tooLarge(`${formatA1Range(range)} is ${count} cells, over the ${max}-cell read limit`)
  }
  const { range: bounded, truncated } = options.clamp ? clampRange(range, max) : { range, truncated: false }
  const wantValues = options.values !== false
  const values: string[][] = []
  const formulas: string[][] = []
  const types: number[][] = []
  for (let row = bounded.r0; row <= bounded.r1; row++) {
    const valueRow: string[] = []
    const formulaRow: string[] = []
    const typeRow: number[] = []
    for (let column = bounded.c0; column <= bounded.c1; column++) {
      if (wantValues) valueRow.push(model.formattedValue(sheet, row, column) ?? '')
      if (options.formulas) formulaRow.push(model.cellContent(sheet, row, column) ?? '')
      if (options.types) typeRow.push(model.cellType(sheet, row, column))
    }
    if (wantValues) values.push(valueRow)
    if (options.formulas) formulas.push(formulaRow)
    if (options.types) types.push(typeRow)
  }
  return {
    sheet,
    sheetName: sheetName(model, sheet),
    range: bounded,
    a1: formatA1Range(bounded),
    rowCount: bounded.r1 - bounded.r0 + 1,
    columnCount: bounded.c1 - bounded.c0 + 1,
    ...(wantValues ? { values } : {}),
    ...(options.formulas ? { formulas } : {}),
    ...(options.types ? { types } : {}),
    truncated,
  }
}

/**
 * The bounding box of the sheet's non-empty cells, or null when the sheet is
 * empty. Both bindings report `[1, 1, 1, 1]` for an empty sheet, which is
 * indistinguishable from a sheet holding only `A1`, so A1 is probed.
 */
export function usedRange(model: SpreadsheetEngineModel, sheet: number): SpreadsheetSelection | null {
  const [minRow, minColumn, maxRow, maxColumn] = model.dimensions(sheet)
  const range = { r0: minRow, c0: minColumn, r1: maxRow, c1: maxColumn }
  if (selectionCellCount(range) !== 1) return range
  const content = model.cellContent(sheet, range.r0, range.c0)
  return content ? range : null
}

export interface SpreadsheetSheetDescription extends SpreadsheetSheetInfo {
  usedRange: SpreadsheetSelection | null
  usedRangeA1: string | null
  rowCount: number
  columnCount: number
  frozenRows: number
  frozenColumns: number
}

export interface SpreadsheetDescription {
  binding: 'node' | 'wasm'
  sheetCount: number
  sheets: SpreadsheetSheetDescription[]
}

/** What `sheet_describe` and the pane's tab strip both need, and nothing else. */
export function describe(model: SpreadsheetEngineModel): SpreadsheetDescription {
  const sheets = model.sheets().map((properties, index) => {
    const used = usedRange(model, index)
    return {
      index,
      name: properties.name,
      hidden: (properties.state ?? 'visible') !== 'visible',
      color: properties.color ?? null,
      usedRange: used,
      usedRangeA1: used ? formatA1Range(used) : null,
      rowCount: used ? used.r1 - used.r0 + 1 : 0,
      columnCount: used ? used.c1 - used.c0 + 1 : 0,
      frozenRows: model.frozenRowsCount(index),
      frozenColumns: model.frozenColumnsCount(index),
    }
  })
  return { binding: model.binding, sheetCount: sheets.length, sheets }
}

/**
 * The first `limit` rows of a sheet's used range as formatted values — the
 * preview a tool answer or a projection header wants without asking the caller
 * to work out a range first.
 */
export function readHead(
  model: SpreadsheetEngineModel,
  sheet: number,
  limit = 20,
  options: ReadRangeOptions = {},
): ReadRangeResult | null {
  const used = usedRange(model, sheet)
  if (!used) return null
  const head = { ...used, r1: Math.min(used.r1, used.r0 + limit - 1) }
  return readRange(model, sheet, head, { ...options, clamp: true })
}

/** A1 address of one cell, re-exported so read callers need only this module. */
export { cellA1 }
