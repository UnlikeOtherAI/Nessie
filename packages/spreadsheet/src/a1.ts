import {
  SPREADSHEET_LIMITS,
  SPREADSHEET_MAX_COLUMNS,
  SPREADSHEET_MAX_ROWS,
  SPREADSHEET_ERROR_CODES,
  columnIndexToLabel,
  columnLabelToIndex,
  formatA1Range,
  parseA1Range,
  selectionCellCount,
  SpreadsheetSelectionSchema,
  A1Schema,
  type SpreadsheetRectangle,
  type SpreadsheetSelection,
} from '@nessie/schemas'

import { SpreadsheetEngineError } from './engine.js'

// Addressing, in one place. The schema package owns parsing and formatting so
// the API, the tools and the pane all agree on what `B2:D40` means; this module
// re-exports those and adds the two things only the engine layer needs:
// enumerating a range under the read cap, and turning a sheet *name* into the
// index IronCalc addresses sheets by.

export {
  A1Schema,
  SPREADSHEET_LIMITS,
  SPREADSHEET_MAX_COLUMNS,
  SPREADSHEET_MAX_ROWS,
  SpreadsheetSelectionSchema,
  columnIndexToLabel,
  columnLabelToIndex,
  formatA1Range,
  parseA1Range,
  selectionCellCount,
}
export type { SpreadsheetRectangle, SpreadsheetSelection }

export interface SpreadsheetCellAddress {
  row: number
  column: number
  a1: string
}

export function cellA1(row: number, column: number): string {
  return `${columnIndexToLabel(column)}${row}`
}

export function tooLarge(message: string): SpreadsheetEngineError {
  return new SpreadsheetEngineError(SPREADSHEET_ERROR_CODES.tooLarge, message)
}

export interface RangeToCellsOptions {
  /** Defaults to `maxCellsPerRead`; a bigger range throws `SPREADSHEET_TOO_LARGE`. */
  max?: number
}

/** Row-major enumeration of a range, refused rather than truncated past the cap. */
export function rangeToCells(range: SpreadsheetSelection, options: RangeToCellsOptions = {}): SpreadsheetCellAddress[] {
  const selection = SpreadsheetSelectionSchema.parse(range)
  const max = options.max ?? SPREADSHEET_LIMITS.maxCellsPerRead
  const count = selectionCellCount(selection)
  if (count > max) {
    throw tooLarge(`${formatA1Range(selection)} is ${count} cells, over the ${max}-cell limit`)
  }
  const cells: SpreadsheetCellAddress[] = []
  for (let row = selection.r0; row <= selection.r1; row++) {
    for (let column = selection.c0; column <= selection.c1; column++) {
      cells.push({ row, column, a1: cellA1(row, column) })
    }
  }
  return cells
}

/** Clip a range to whole rows so it fits `max` cells. `truncated` says it bit. */
export function clampRange(
  range: SpreadsheetSelection,
  max: number = SPREADSHEET_LIMITS.maxCellsPerRead,
): { range: SpreadsheetSelection; truncated: boolean } {
  const selection = SpreadsheetSelectionSchema.parse(range)
  if (selectionCellCount(selection) <= max) return { range: selection, truncated: false }
  const width = selection.c1 - selection.c0 + 1
  const rows = Math.max(1, Math.floor(max / width))
  const clipped = { ...selection, r1: Math.min(selection.r1, selection.r0 + rows - 1) }
  if (selectionCellCount(clipped) > max) {
    // One row is already wider than the cap: clip the columns too.
    return { range: { ...clipped, c1: selection.c0 + max - 1 }, truncated: true }
  }
  return { range: clipped, truncated: true }
}

/**
 * Sheet name → index. An exact match always wins; only when there is none does
 * a case-insensitive match count, because IronCalc lets `Data` and `data`
 * coexist and picking the wrong one silently writes to the wrong tab. Returns
 * -1 when nothing matches.
 */
export function resolveSheetIndex(names: readonly string[], name: string): number {
  const wanted = name.trim()
  const exact = names.indexOf(wanted)
  if (exact !== -1) return exact
  const folded = wanted.toLowerCase()
  for (let index = 0; index < names.length; index++) {
    if (names[index]?.toLowerCase() === folded) return index
  }
  return -1
}

/** The same lookup, but a miss is an error the caller can hand to a tool. */
export function requireSheetIndex(names: readonly string[], name: string): number {
  const index = resolveSheetIndex(names, name)
  if (index === -1) {
    throw new SpreadsheetEngineError(
      SPREADSHEET_ERROR_CODES.batchRejected,
      `no sheet named ${JSON.stringify(name)}; the workbook has ${names.map((n) => JSON.stringify(n)).join(', ')}`,
    )
  }
  return index
}

export function rectangleOf(sheet: number, range: SpreadsheetSelection): SpreadsheetRectangle {
  return { sheet, r0: range.r0, c0: range.c0, r1: range.r1, c1: range.c1 }
}

export function rangesOverlap(a: SpreadsheetSelection, b: SpreadsheetSelection): boolean {
  return a.r0 <= b.r1 && b.r0 <= a.r1 && a.c0 <= b.c1 && b.c0 <= a.c1
}

export function rangeContains(outer: SpreadsheetSelection, row: number, column: number): boolean {
  return row >= outer.r0 && row <= outer.r1 && column >= outer.c0 && column <= outer.c1
}
