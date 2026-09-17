import { SPREADSHEET_ERROR_CODES, type SpreadsheetSelection } from '@nessie/schemas'

// One interface every caller codes against, and one thin adapter per IronCalc
// binding. The plan assumed the two bindings were structurally interchangeable
// because they share method names. Spike A proved they are not: updateRangeStyle
// takes an Area in wasm and five integers in Node, getCellStyle is wrapped in
// wasm and bare in Node, and getSheetDimensions exists only in Node (and returns
// [minRow, maxRow, minColumn, maxColumn], not the corner order you expect).
// docs/plans/2026-09-15-spreadsheets-ironcalc/decisions.md

export interface SpreadsheetCellStyle {
  num_fmt?: string
  font?: { b?: boolean; i?: boolean; u?: boolean; strike?: boolean; sz?: number; color?: string; name?: string }
  fill?: { fg_color?: string; bg_color?: string }
  alignment?: { horizontal?: string; vertical?: string; wrap_text?: boolean }
  quote_prefix?: boolean
  [key: string]: unknown
}

export interface SpreadsheetSheetProperties {
  name: string
  state?: string
  color?: string | null
  sheetId?: number
}

/** The engine surface Nessie uses. Anything outside it stays inside an adapter. */
export interface SpreadsheetEngineModel {
  readonly binding: 'node' | 'wasm'

  // journal
  toBytes(): Uint8Array
  flushSendQueue(): Uint8Array
  applyExternalDiffs(diffs: Uint8Array): void

  // evaluation — never apply without pausing (38 minutes vs 164 ms for 200k diffs)
  pauseEvaluation(): void
  resumeEvaluation(): void
  evaluate(): void

  // reads
  sheets(): SpreadsheetSheetProperties[]
  /** [minRow, minColumn, maxRow, maxColumn], 1-based inclusive, corner order. */
  dimensions(sheet: number): [number, number, number, number]
  cellContent(sheet: number, row: number, column: number): string
  formattedValue(sheet: number, row: number, column: number): string
  cellType(sheet: number, row: number, column: number): number
  cellStyle(sheet: number, row: number, column: number): SpreadsheetCellStyle

  // writes
  setUserInput(sheet: number, row: number, column: number, value: string): void
  updateRangeStyle(sheet: number, range: SpreadsheetSelection, stylePath: string, value: string): void
  /** Whole style objects in one call — what sort needs to carry formatting.
   *  `updateRangeStyle` only sets one path at a time, and neither binding has a
   *  runtime `setCellStyle` (it is declared on the Node `Model`, not on
   *  `UserModel`, the same trap `getAllCells` sets). `onPasteStyles` is what
   *  both actually expose, so this writes a matrix anchored at (row, column).
   *  It moves the model's selected view and puts it back. */
  setRangeStyles(sheet: number, row: number, column: number, styles: SpreadsheetCellStyle[][]): void
  rangeClear(kind: 'all' | 'contents' | 'formatting', sheet: number, range: SpreadsheetSelection): void
  insertRows(sheet: number, row: number, count: number): void
  deleteRows(sheet: number, row: number, count: number): void
  insertColumns(sheet: number, column: number, count: number): void
  deleteColumns(sheet: number, column: number, count: number): void
  /** Cut-and-reinsert, not overwrite: the rows in between close the gap. */
  moveRows(sheet: number, row: number, count: number, delta: number): void
  moveColumns(sheet: number, column: number, count: number, delta: number): void
  /** Hidden is NOT queryable as a boolean: neither binding has getRowsHidden.
   *  A hidden row reports height 0 and a hidden column width 0, which is what
   *  `isRowHidden`/`isColumnHidden` below read. Spike B, spike-b-xlsx.md. */
  setRowsHidden(sheet: number, start: number, end: number, hidden: boolean): void
  setColumnsHidden(sheet: number, start: number, end: number, hidden: boolean): void
  setRowsHeight(sheet: number, start: number, end: number, height: number): void
  setColumnsWidth(sheet: number, start: number, end: number, width: number): void
  rowHeight(sheet: number, row: number): number
  columnWidth(sheet: number, column: number): number
  isRowHidden(sheet: number, row: number): boolean
  isColumnHidden(sheet: number, column: number): boolean
  setFrozenRowsCount(sheet: number, count: number): void
  setFrozenColumnsCount(sheet: number, count: number): void
  frozenRowsCount(sheet: number): number
  frozenColumnsCount(sheet: number): number

  // sheets
  newSheet(): void
  deleteSheet(sheet: number): void
  renameSheet(sheet: number, name: string): void
  moveSheet(sheet: number, newIndex: number): void
  hideSheet(sheet: number): void
  unhideSheet(sheet: number): void
}

export class SpreadsheetEngineError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = 'SpreadsheetEngineError'
    this.code = code
  }
}

/** Shapes of the two raw bindings, kept structural so neither package is a
 *  build-time dependency of this module's type surface. */
interface RawNodeModel {
  toBytes(): Uint8Array
  flushSendQueue(): Uint8Array
  applyExternalDiffs(diffs: Uint8Array): void
  pauseEvaluation(): void
  resumeEvaluation(): void
  evaluate(): void
  getWorksheetsProperties(): SpreadsheetSheetProperties[]
  getSheetDimensions(sheet: number): [number, number, number, number]
  getCellContent(sheet: number, row: number, column: number): string
  getFormattedCellValue(sheet: number, row: number, column: number): string
  getCellType(sheet: number, row: number, column: number): number
  getCellStyle(sheet: number, row: number, column: number): SpreadsheetCellStyle
  setUserInput(sheet: number, row: number, column: number, value: string): void
  updateRangeStyle(
    sheet: number,
    startRow: number,
    startColumn: number,
    endRow: number,
    endColumn: number,
    stylePath: string,
    value: string,
  ): void
  onPasteStyles(styles: SpreadsheetCellStyle[][]): void
  getSelectedView(): { sheet: number; row: number; column: number; range: [number, number, number, number] }
  setSelectedSheet(sheet: number): void
  setSelectedCell(row: number, column: number): void
  setSelectedRange(r0: number, c0: number, r1: number, c1: number): void
  getRowHeight(sheet: number, row: number): number
  getColumnWidth(sheet: number, column: number): number
  rangeClearAll(sheet: number, r0: number, c0: number, r1: number, c1: number): void
  rangeClearContents(sheet: number, r0: number, c0: number, r1: number, c1: number): void
  rangeClearFormatting(sheet: number, r0: number, c0: number, r1: number, c1: number): void
  insertRows(sheet: number, row: number, count: number): void
  deleteRows(sheet: number, row: number, count: number): void
  insertColumns(sheet: number, column: number, count: number): void
  deleteColumns(sheet: number, column: number, count: number): void
  moveRows(sheet: number, row: number, count: number, delta: number): void
  moveColumns(sheet: number, column: number, count: number, delta: number): void
  setRowsHidden(sheet: number, start: number, end: number, hidden: boolean): void
  setColumnsHidden(sheet: number, start: number, end: number, hidden: boolean): void
  setRowsHeight(sheet: number, start: number, end: number, height: number): void
  setColumnsWidth(sheet: number, start: number, end: number, width: number): void
  setFrozenRowsCount(sheet: number, count: number): void
  setFrozenColumnsCount(sheet: number, count: number): void
  getFrozenRowsCount(sheet: number): number
  getFrozenColumnsCount(sheet: number): number
  newSheet(): void
  deleteSheet(sheet: number): void
  renameSheet(sheet: number, name: string): void
  moveSheet(sheet: number, newIndex: number): void
  hideSheet(sheet: number): void
  unhideSheet(sheet: number): void
}

interface RawWasmArea {
  sheet: number
  row: number
  column: number
  width: number
  height: number
}

interface RawWasmModel
  extends Omit<
    RawNodeModel,
    | 'getSheetDimensions'
    | 'updateRangeStyle'
    | 'getCellStyle'
    | 'rangeClearAll'
    | 'rangeClearContents'
    | 'rangeClearFormatting'
  > {
  getRowsWithData(sheet: number, column: number): Int32Array
  getColumnsWithData(sheet: number, row: number): Int32Array
  updateRangeStyle(range: RawWasmArea, stylePath: string, value: string): void
  getCellStyle(sheet: number, row: number, column: number): { style: SpreadsheetCellStyle } | SpreadsheetCellStyle
  rangeClearAll(range: RawWasmArea): void
  rangeClearContents(range: RawWasmArea): void
  rangeClearFormatting(range: RawWasmArea): void
}

const areaOf = (sheet: number, range: SpreadsheetSelection): RawWasmArea => ({
  sheet,
  row: range.r0,
  column: range.c0,
  width: range.c1 - range.c0 + 1,
  height: range.r1 - range.r0 + 1,
})

/** Node's `UserModel` — the canonical server-side engine. */
export function wrapNodeModel(raw: RawNodeModel): SpreadsheetEngineModel {
  return {
    binding: 'node',
    toBytes: () => raw.toBytes(),
    flushSendQueue: () => raw.flushSendQueue(),
    applyExternalDiffs: (diffs) => raw.applyExternalDiffs(diffs),
    pauseEvaluation: () => raw.pauseEvaluation(),
    resumeEvaluation: () => raw.resumeEvaluation(),
    evaluate: () => raw.evaluate(),
    sheets: () => raw.getWorksheetsProperties(),
    dimensions: (sheet) => {
      const [minRow, maxRow, minColumn, maxColumn] = raw.getSheetDimensions(sheet)
      return [minRow, minColumn, maxRow, maxColumn]
    },
    cellContent: (s, r, c) => raw.getCellContent(s, r, c),
    formattedValue: (s, r, c) => raw.getFormattedCellValue(s, r, c),
    cellType: (s, r, c) => raw.getCellType(s, r, c),
    cellStyle: (s, r, c) => raw.getCellStyle(s, r, c),
    setUserInput: (s, r, c, v) => raw.setUserInput(s, r, c, v),
    updateRangeStyle: (s, range, path, value) =>
      raw.updateRangeStyle(s, range.r0, range.c0, range.r1, range.c1, path, value),
    setRangeStyles: (s, r, c, styles) => {
      if (styles.length === 0) return
      const view = raw.getSelectedView()
      raw.setSelectedSheet(s)
      raw.setSelectedCell(r, c)
      raw.onPasteStyles(styles)
      raw.setSelectedSheet(view.sheet)
      raw.setSelectedCell(view.row, view.column)
    },
    rangeClear: (kind, s, range) => {
      const call =
        kind === 'all' ? raw.rangeClearAll : kind === 'contents' ? raw.rangeClearContents : raw.rangeClearFormatting
      call.call(raw, s, range.r0, range.c0, range.r1, range.c1)
    },
    insertRows: (s, row, count) => raw.insertRows(s, row, count),
    deleteRows: (s, row, count) => raw.deleteRows(s, row, count),
    insertColumns: (s, column, count) => raw.insertColumns(s, column, count),
    deleteColumns: (s, column, count) => raw.deleteColumns(s, column, count),
    moveRows: (s, row, count, delta) => raw.moveRows(s, row, count, delta),
    moveColumns: (s, column, count, delta) => raw.moveColumns(s, column, count, delta),
    setRowsHidden: (s, a, b, hidden) => raw.setRowsHidden(s, a, b, hidden),
    setColumnsHidden: (s, a, b, hidden) => raw.setColumnsHidden(s, a, b, hidden),
    setRowsHeight: (s, a, b, h) => raw.setRowsHeight(s, a, b, h),
    setColumnsWidth: (s, a, b, w) => raw.setColumnsWidth(s, a, b, w),
    rowHeight: (s, row) => raw.getRowHeight(s, row),
    columnWidth: (s, column) => raw.getColumnWidth(s, column),
    isRowHidden: (s, row) => raw.getRowHeight(s, row) === 0,
    isColumnHidden: (s, column) => raw.getColumnWidth(s, column) === 0,
    setFrozenRowsCount: (s, n) => raw.setFrozenRowsCount(s, n),
    setFrozenColumnsCount: (s, n) => raw.setFrozenColumnsCount(s, n),
    frozenRowsCount: (s) => raw.getFrozenRowsCount(s),
    frozenColumnsCount: (s) => raw.getFrozenColumnsCount(s),
    newSheet: () => raw.newSheet(),
    deleteSheet: (s) => raw.deleteSheet(s),
    renameSheet: (s, name) => raw.renameSheet(s, name),
    moveSheet: (s, index) => raw.moveSheet(s, index),
    hideSheet: (s) => raw.hideSheet(s),
    unhideSheet: (s) => raw.unhideSheet(s),
  }
}

/** The browser engine, also used in Node tests as the second party of a pair. */
export function wrapWasmModel(raw: RawWasmModel, scanColumns = 200): SpreadsheetEngineModel {
  const node = wrapNodeModel(raw as unknown as RawNodeModel)
  return {
    ...node,
    binding: 'wasm',
    // wasm has no getSheetDimensions; walk the per-column row indexes instead.
    dimensions: (sheet) => {
      let minRow = Number.MAX_SAFE_INTEGER
      let minColumn = Number.MAX_SAFE_INTEGER
      let maxRow = 0
      let maxColumn = 0
      for (let column = 1; column <= scanColumns; column++) {
        const rows = raw.getRowsWithData(sheet, column)
        if (rows.length === 0) continue
        if (column < minColumn) minColumn = column
        if (column > maxColumn) maxColumn = column
        for (const row of rows) {
          if (row < minRow) minRow = row
          if (row > maxRow) maxRow = row
        }
      }
      return maxRow === 0 ? [1, 1, 1, 1] : [minRow, minColumn, maxRow, maxColumn]
    },
    cellStyle: (s, r, c) => {
      const raw_ = raw.getCellStyle(s, r, c)
      return raw_ && typeof raw_ === 'object' && 'style' in raw_
        ? (raw_ as { style: SpreadsheetCellStyle }).style
        : (raw_ as SpreadsheetCellStyle)
    },
    updateRangeStyle: (s, range, path, value) => raw.updateRangeStyle(areaOf(s, range), path, value),
    rangeClear: (kind, s, range) => {
      const area = areaOf(s, range)
      if (kind === 'all') raw.rangeClearAll(area)
      else if (kind === 'contents') raw.rangeClearContents(area)
      else raw.rangeClearFormatting(area)
    },
  }
}

/** Stands in wherever a phase needs the interface before its engine is wired. */
export function createUnimplementedModel(): SpreadsheetEngineModel {
  const fail = (): never => {
    throw new SpreadsheetEngineError(
      SPREADSHEET_ERROR_CODES.engineUnavailable,
      'the spreadsheet engine is not available in this process',
    )
  }
  return new Proxy({ binding: 'node' } as SpreadsheetEngineModel, {
    get: (target, property) => (property === 'binding' ? target.binding : fail),
  })
}
