// The Spike B fixture workbook, built by a writer that is not IronCalc.
//
// Nothing here is checked in: a 50 000-cell .xlsx is 200 KB of binary that
// would rot in git, and the point of the fixture is that a *foreign* writer
// produced it, which a generator states more honestly than a blob. exceljs
// is the repo's existing xlsx writer (`packages/dashboard`).
//
// `buildForeignWorkbook` covers everything the plan claims survives an
// import — cross-sheet formulas, SUM/VLOOKUP/IF/date/text functions, merges,
// number formats, bold/colour/border styles, frozen panes, named ranges,
// hidden rows and columns, an autofilter — plus the features Spike B
// measured as lost, so the warnings scan has something to find.

import ExcelJS from 'exceljs'

/** Sheet indexes of the generated workbook, in the order it creates them. */
export const SHEET = { data: 0, lookup: 1, calc: 2, bulk: 3, notes: 4 } as const

export const REGIONS = ['North', 'South', 'East', 'West'] as const

/** Rows of real data on `Data`; drives the total cell count. */
export const DATA_ROWS = 2000
/** Rows of cross-sheet formulas on `Calc`. */
export const CALC_ROWS = 50
/** Rows of plain numbers on `Bulk`, the bulk of the cell count. */
export const BULK_ROWS = 1700
export const BULK_COLUMNS = 20

/** ≈ 51 000 cells across five sheets. */
export const EXPECTED_CELL_COUNT =
  DATA_ROWS * 7 + 7 + 2 + 10 + CALC_ROWS * 6 + 3 + BULK_ROWS * BULK_COLUMNS + 42

/** A 1×1 transparent PNG, so the package carries a real `xl/media/` part. */
const PIXEL_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

function buildData(workbook: ExcelJS.Workbook): void {
  const sheet = workbook.addWorksheet('Data')
  sheet.columns = [
    { header: 'Id', width: 8 },
    { header: 'Name', width: 24 },
    { header: 'Region', width: 14 },
    { header: 'Date', width: 14 },
    { header: 'Amount', width: 14 },
    { header: 'Tax', width: 14 },
    { header: 'Total', width: 14 },
  ]
  for (let i = 1; i <= DATA_ROWS; i++) {
    const row = i + 1
    sheet.getCell(`A${row}`).value = i
    sheet.getCell(`B${row}`).value = `Customer ${i}`
    sheet.getCell(`C${row}`).value = REGIONS[i % 4]
    const date = sheet.getCell(`D${row}`)
    date.value = new Date(Date.UTC(2024, i % 12, (i % 28) + 1))
    date.numFmt = 'yyyy-mm-dd'
    const amount = sheet.getCell(`E${row}`)
    amount.value = Math.round(i * 13.37 * 100) / 100
    amount.numFmt = '#,##0.00'
    sheet.getCell(`F${row}`).value = { formula: `E${row}*0.21` } as ExcelJS.CellFormulaValue
    const total = sheet.getCell(`G${row}`)
    total.value = { formula: `E${row}+F${row}` } as ExcelJS.CellFormulaValue
    total.numFmt = '"$"#,##0.00'
  }
  sheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } }
  sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF2F5597' } }
  sheet.views = [{ state: 'frozen', xSplit: 2, ySplit: 1 }]
  sheet.autoFilter = 'A1:G1'
  sheet.getRow(5).hidden = true
  sheet.getColumn(6).hidden = true
  sheet.mergeCells('I1:K1')
  sheet.getCell('I1').value = 'MERGED BANNER'
  const bordered = sheet.getCell('I2')
  bordered.value = 'bordered'
  bordered.border = {
    top: { style: 'thin' },
    left: { style: 'thin' },
    bottom: { style: 'double', color: { argb: 'FFFF0000' } },
    right: { style: 'thin' },
  }
}

function buildCalc(workbook: ExcelJS.Workbook): void {
  const sheet = workbook.addWorksheet('Calc')
  const formula = (f: string): ExcelJS.CellFormulaValue => ({ formula: f }) as ExcelJS.CellFormulaValue
  for (let i = 1; i <= CALC_ROWS; i++) {
    sheet.getCell(`A${i}`).value = formula(`Data!E${i + 1}`)
    sheet.getCell(`B${i}`).value = formula(
      `VLOOKUP(Data!C${i + 1},Lookup!$A$2:$B$5,2,FALSE)`,
    )
    sheet.getCell(`C${i}`).value = formula(`IF(A${i}>1000,"big","small")`)
    sheet.getCell(`D${i}`).value = formula(`TEXT(Data!D${i + 1},"yyyy")`)
    sheet.getCell(`E${i}`).value = formula(`UPPER(LEFT(Data!B${i + 1},4))`)
    sheet.getCell(`F${i}`).value = formula(`SUM(Data!$E$2:$E$${i + 1})`)
  }
  sheet.getCell('H1').value = formula(`SUM(Data!E2:E${DATA_ROWS + 1})`)
  sheet.getCell('H2').value = formula(`COUNTA(Data!B2:B${DATA_ROWS + 1})`)
  sheet.getCell('H3').value = formula('SUM(GrandTotal)')
}

/** The whole fixture, written to `filePath`. Returns the byte size. */
export async function buildForeignWorkbook(filePath: string): Promise<number> {
  const workbook = new ExcelJS.Workbook()
  buildData(workbook)

  const lookup = workbook.addWorksheet('Lookup')
  lookup.getCell('A1').value = 'Region'
  lookup.getCell('B1').value = 'Rate'
  REGIONS.forEach((region, i) => {
    lookup.getCell(`A${i + 2}`).value = region
    lookup.getCell(`B${i + 2}`).value = 0.1 * (i + 1)
  })

  buildCalc(workbook)

  const bulk = workbook.addWorksheet('Bulk')
  for (let r = 1; r <= BULK_ROWS; r++) {
    const row = bulk.getRow(r)
    for (let c = 1; c <= BULK_COLUMNS; c++) row.getCell(c).value = r * 100 + c
  }

  const notes = workbook.addWorksheet('Notes')
  notes.getCell('A1').value = 'Notes sheet'
  notes.getCell('A2').value = { text: 'IronCalc', hyperlink: 'https://www.ironcalc.com/' }
  notes.getCell('A3').note = 'a cell comment'
  notes.getCell('A4').dataValidation = { type: 'list', allowBlank: false, formulae: ['"a,b,c"'] }
  notes.addConditionalFormatting({
    ref: 'B1:B20',
    rules: [
      {
        type: 'cellIs',
        operator: 'greaterThan',
        priority: 1,
        formulae: ['5'],
        style: { fill: { type: 'pattern', pattern: 'solid', bgColor: { argb: 'FFFF0000' } } },
      },
    ],
  })
  for (let i = 1; i <= 20; i++) notes.getCell(`B${i}`).value = i
  notes.addTable({
    name: 'Rates',
    ref: 'D10',
    headerRow: true,
    style: { theme: 'TableStyleMedium2', showRowStripes: true },
    columns: [{ name: 'Region', filterButton: true }, { name: 'Rate' }],
    rows: REGIONS.map((region, i) => [region, 0.1 * (i + 1)]),
  })
  notes.getRow(6).outlineLevel = 1
  notes.protect('spike', {})
  const image = workbook.addImage({ base64: PIXEL_PNG, extension: 'png' })
  notes.addImage(image, 'D2:E6')

  workbook.definedNames.add(`Data!$E$2:$E$${DATA_ROWS + 1}`, 'GrandTotal')
  workbook.definedNames.add('Lookup!$A$2:$B$5', 'RateTable')

  await workbook.xlsx.writeFile(filePath)
  const { statSync } = await import('node:fs')
  return statSync(filePath).size
}
