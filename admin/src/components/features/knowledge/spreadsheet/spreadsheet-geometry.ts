// Canvas geometry, re-implemented from `WorksheetCanvas`'s own sums.
//
// The canvas instance is private to IronCalc's `Workbook`, so anything drawn
// *over* the grid — the filter funnel buttons here, Phase 3b's presence overlay
// and touch handles — has to recompute where a cell is. Both layers read this
// one module so they can never disagree about where B4 is.
//
// The two constants are IronCalc's own header sizes, measured in the Spike C/D
// run and asserted by the geometry test.
import type { Model } from '@ironcalc/wasm'

export const HEADER_ROW_HEIGHT = 28
export const HEADER_COLUMN_WIDTH = 30

export type CellRect = { height: number; left: number; top: number; width: number }

/**
 * The rectangle of `(row, column)` in the scroll container's own coordinates:
 * the origin is the container's top-left, including its headers.
 *
 * Frozen panes are honoured — a cell inside the frozen band never scrolls, so
 * its offset is measured from row/column 1 rather than from the viewport's
 * first visible row.
 */
export const cellRect = (model: Model, sheet: number, row: number, column: number): CellRect => {
  const view = model.getSelectedView()
  const frozenRows = model.getFrozenRowsCount(sheet)
  const frozenColumns = model.getFrozenColumnsCount(sheet)
  const firstRow = row <= frozenRows ? 1 : Math.max(view.top_row, frozenRows + 1)
  const firstColumn = column <= frozenColumns ? 1 : Math.max(view.left_column, frozenColumns + 1)

  let top = HEADER_ROW_HEIGHT
  if (row > frozenRows) for (let r = 1; r <= frozenRows; r += 1) top += model.getRowHeight(sheet, r)
  for (let r = firstRow; r < row; r += 1) top += model.getRowHeight(sheet, r)

  let left = HEADER_COLUMN_WIDTH
  if (column > frozenColumns) {
    for (let c = 1; c <= frozenColumns; c += 1) left += model.getColumnWidth(sheet, c)
  }
  for (let c = firstColumn; c < column; c += 1) left += model.getColumnWidth(sheet, c)

  return {
    height: model.getRowHeight(sheet, row),
    left,
    top,
    width: model.getColumnWidth(sheet, column),
  }
}

/** The inverse: which cell is under a point in the same coordinates. */
export const cellFromPoint = (
  model: Model,
  sheet: number,
  x: number,
  y: number,
): [number, number] => {
  const view = model.getSelectedView()
  let row = Math.max(view.top_row, 1)
  let top = HEADER_ROW_HEIGHT
  while (top + model.getRowHeight(sheet, row) < y && row < 1_048_576) {
    top += model.getRowHeight(sheet, row)
    row += 1
  }
  let column = Math.max(view.left_column, 1)
  let left = HEADER_COLUMN_WIDTH
  while (left + model.getColumnWidth(sheet, column) < x && column < 16_384) {
    left += model.getColumnWidth(sheet, column)
    column += 1
  }
  return [row, column]
}
