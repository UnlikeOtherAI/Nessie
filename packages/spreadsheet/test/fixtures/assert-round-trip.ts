// The round-trip expectations for the workbook `build-fixtures.ts` generates:
// everything the build contract claims an .xlsx import preserves, asserted on
// one model so the same checks run before and after `saveToXlsx`.

import assert from 'node:assert/strict'

import type { UserModel } from '@ironcalc/nodejs'

import { BULK_ROWS, DATA_ROWS, SHEET } from './build-fixtures.js'

/**
 * Everything the plan claims an .xlsx import preserves, asserted on one model.
 * Returned so the caller can compare the two passes' grand total.
 */
export function assertPreserved(model: UserModel): string {
  assert.deepEqual(
    model.getWorksheetsProperties().map((s) => s.name),
    ['Data', 'Lookup', 'Calc', 'Bulk', 'Notes'],
  )
  assert.deepEqual(model.getSheetDimensions(SHEET.data), [1, DATA_ROWS + 1, 1, 11])
  assert.deepEqual(model.getSheetDimensions(SHEET.bulk), [1, BULK_ROWS, 1, 20])

  // Contents (formulas stay formulas, not cached values), computed values and
  // types, across the function families the plan names.
  const cells: Array<[readonly [number, number, number], string, string, number]> = [
    [[SHEET.data, 2, 2], 'Customer 1', 'Customer 1', 2],
    [[SHEET.data, 2, 4], '2024-02-02', '2024-02-02', 1],
    [[SHEET.data, 2, 5], '13.37', '13.37', 1],
    [[SHEET.data, 2, 6], '=E2*0.21', '2.8077', 1],
    [[SHEET.data, 2, 7], '=E2+F2', '$16.18', 1],
    [[SHEET.data, 1, 9], 'MERGED BANNER', 'MERGED BANNER', 2],
    [[SHEET.calc, 1, 2], '=VLOOKUP(Data!C2,Lookup!$A$2:$B$5,2,FALSE)', '0.2', 1],
    [[SHEET.calc, 1, 3], '=IF(A1>1000,"big","small")', 'small', 2],
    [[SHEET.calc, 1, 4], '=TEXT(Data!D2,"yyyy")', '2024', 2],
    [[SHEET.calc, 1, 5], '=UPPER(LEFT(Data!B2,4))', 'CUST', 2],
    [[SHEET.calc, 2, 8], `=COUNTA(Data!B2:B${DATA_ROWS + 1})`, '2000', 1],
    [[SHEET.bulk, BULK_ROWS, 20], '170020', '170020', 1],
  ]
  for (const [[sheet, row, column], content, value, type] of cells) {
    const at = `${sheet}!r${row}c${column}`
    assert.equal(model.getCellContent(sheet, row, column), content, at)
    assert.equal(model.getFormattedCellValue(sheet, row, column), value, at)
    assert.equal(model.getCellType(sheet, row, column), type, at)
  }

  // Styles: bold, font colour, fill, number formats, borders.
  const header = model.getCellStyle(SHEET.data, 1, 1)
  assert.equal(header.font.b, true)
  assert.equal(header.font.color, '#FFFFFF')
  assert.equal(header.fill.color, '#2F5597')
  for (const [column, format] of [
    [4, 'yyyy-mm-dd'],
    [5, '#,##0.00'],
    [7, '"$"#,##0.00'],
  ] as const) {
    assert.equal(model.getCellStyle(SHEET.data, 2, column).num_fmt, format)
  }
  const borders = model.getCellStyle(SHEET.data, 2, 9).border
  assert.equal(borders.top?.style, 'thin')
  assert.equal(borders.bottom?.style, 'double')
  assert.equal(borders.bottom?.color, '#FF0000')

  // Structure: frozen panes, hidden row and column (height/width 0), explicit
  // column widths, named ranges, conditional formatting.
  assert.equal(model.getFrozenRowsCount(SHEET.data), 1)
  assert.equal(model.getFrozenColumnsCount(SHEET.data), 2)
  assert.equal(model.getRowHeight(SHEET.data, 5), 0)
  assert.equal(model.getColumnWidth(SHEET.data, 6), 0)
  assert.equal(model.getColumnWidth(SHEET.data, 2), 216)
  assert.deepEqual(
    model.getDefinedNameList().map((n) => n.name).sort(),
    ['GrandTotal', 'RateTable'],
  )
  assert.equal(model.getConditionalFormattingList(SHEET.notes).length, 1)

  // SUM over 2 000 cells, and the same sum reached through a defined name.
  const grandTotal = model.getFormattedCellValue(SHEET.calc, 1, 8)
  assert.equal(model.getFormattedCellValue(SHEET.calc, 3, 8), grandTotal)
  return grandTotal
}
