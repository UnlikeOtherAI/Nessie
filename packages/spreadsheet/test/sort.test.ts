import assert from 'node:assert/strict'
import { before, describe, it } from 'node:test'

import type { SpreadsheetEngineModel } from '../src/engine.js'
import { sortOrder, sortRange } from '../src/sort.js'
import { readRange } from '../src/read.js'
import { runPaused } from '../src/write.js'

import { nodeModel, readGrid } from './support/engine.js'

// Sort is ours, not the engine's: `moveRows` was measured at 564 s for 10 000
// rows and corrupted a range outside the block, so the rows are read, ordered
// and written back in one paused batch. There is no merged-cell case to refuse
// — neither binding exposes a merge API at all.

async function workbook(): Promise<SpreadsheetEngineModel> {
  const model = await nodeModel('sort')
  model.newSheet()
  model.renameSheet(1, 'Rates')
  runPaused(model, () => {
    model.setUserInput(1, 1, 1, '0.21')
    const rows: [string, string, string][] = [
      ['Name', 'Qty', 'Total'],
      ['pear', '3', '=B2*10'],
      ['apple', '1', '=B3*10'],
      ['cherry', '10', '=B4*10'],
      ['banana', '2', '=B5*10'],
    ]
    rows.forEach((row, index) =>
      row.forEach((value, column) => model.setUserInput(0, index + 1, column + 1, value)),
    )
    // Column D: a relative, an absolute and an absolute cross-sheet reference.
    for (let row = 2; row <= 5; row++) model.setUserInput(0, row, 4, `=C${row}*$A$1+Rates!$A$1`)
    // Column E: a RELATIVE cross-sheet reference, which shifts like any other.
    for (let row = 2; row <= 5; row++) model.setUserInput(0, row, 5, `=Rates!A${row}`)
    model.updateRangeStyle(0, { r0: 4, c0: 1, r1: 4, c1: 1 }, 'font.b', 'true')
  })
  return model
}

describe('sort', () => {
  let base: SpreadsheetEngineModel

  before(async () => {
    base = await workbook()
  })

  it('orders rows by a key column and keeps the header in place', async () => {
    const model = await workbook()
    sortRange(model, {
      sheet: 0,
      range: { r0: 1, c0: 1, r1: 5, c1: 5 },
      keys: [{ column: 1 }],
      hasHeader: true,
    })
    assert.deepEqual(readGrid(model, 0, 1, 1, 5, 1).flat(), ['Name', 'apple', 'banana', 'cherry', 'pear'])
  })

  it('rewrites formulas by copy semantics so they keep their meaning', async () => {
    const model = await workbook()
    const before = readRange(model, 0, { r0: 2, c0: 3, r1: 5, c1: 3 }, { values: true }).values?.flat()
    sortRange(model, {
      sheet: 0,
      range: { r0: 1, c0: 1, r1: 5, c1: 4 },
      keys: [{ column: 1 }],
      hasHeader: true,
    })
    const after = readRange(model, 0, { r0: 2, c0: 3, r1: 5, c1: 3 }, { formulas: true, values: true })
    // Row 3 (`apple`, qty 1) moved to row 2, so `=B3*10` became `=B2*10`.
    assert.deepEqual(after.formulas?.flat(), ['=B2*10', '=B3*10', '=B4*10', '=B5*10'])
    // The values travelled with their rows rather than staying put.
    assert.deepEqual(after.values?.flat(), ['10', '20', '100', '30'])
    assert.deepEqual([...(before ?? [])].sort(), [...(after.values?.flat() ?? [])].sort())
  })

  it('leaves absolutes alone and shifts relative cross-sheet references', async () => {
    const model = await workbook()
    sortRange(model, {
      sheet: 0,
      range: { r0: 1, c0: 1, r1: 5, c1: 5 },
      keys: [{ column: 1 }],
      hasHeader: true,
    })
    // `$A$1` and `Rates!$A$1` stay; only the relative `C{row}` follows the row.
    assert.deepEqual(readGrid(model, 0, 2, 4, 5, 4, 'content').flat(), [
      '=C2*$A$1+Rates!$A$1',
      '=C3*$A$1+Rates!$A$1',
      '=C4*$A$1+Rates!$A$1',
      '=C5*$A$1+Rates!$A$1',
    ])
    // A relative cross-sheet reference is still relative: sorted from row 3 to
    // row 2, `Rates!A3` becomes `Rates!A2`. `apple` came from row 3, `pear`
    // from row 2 and lands at row 5.
    assert.deepEqual(readGrid(model, 0, 2, 5, 5, 5, 'content').flat(), [
      '=Rates!A2',
      '=Rates!A3',
      '=Rates!A4',
      '=Rates!A5',
    ])
  })

  it('carries styles with their rows', async () => {
    const model = await workbook()
    assert.equal(model.cellStyle(0, 4, 1).font?.b, true) // cherry, before
    sortRange(model, {
      sheet: 0,
      range: { r0: 1, c0: 1, r1: 5, c1: 4 },
      keys: [{ column: 1 }],
      hasHeader: true,
    })
    assert.equal(model.cellContent(0, 4, 1), 'cherry')
    assert.equal(model.cellStyle(0, 4, 1).font?.b, true)
    assert.notEqual(model.cellStyle(0, 5, 1).font?.b, true) // pear did not inherit it
  })

  it('sorts numbers numerically, text after numbers and blanks last', async () => {
    const model = await nodeModel('mixed')
    runPaused(model, () => {
      const values = ['10', 'beta', '2', '', 'alpha', '100']
      values.forEach((value, index) => model.setUserInput(0, index + 1, 1, value))
    })
    sortRange(model, { sheet: 0, range: { r0: 1, c0: 1, r1: 6, c1: 1 }, keys: [{ column: 1 }] })
    assert.deepEqual(readGrid(model, 0, 1, 1, 6, 1).flat(), ['2', '10', '100', 'alpha', 'beta', ''])
  })

  it('reverses on desc but still puts blanks last', async () => {
    const model = await nodeModel('desc')
    runPaused(model, () => {
      ;['10', '', '2', 'alpha'].forEach((value, index) => model.setUserInput(0, index + 1, 1, value))
    })
    sortRange(model, {
      sheet: 0,
      range: { r0: 1, c0: 1, r1: 4, c1: 1 },
      keys: [{ column: 1, direction: 'desc' }],
    })
    assert.deepEqual(readGrid(model, 0, 1, 1, 4, 1).flat(), ['alpha', '10', '2', ''])
  })

  it('is stable across equal keys and honours a second key', async () => {
    const model = await nodeModel('stable')
    runPaused(model, () => {
      const rows = [
        ['b', '2'],
        ['a', '2'],
        ['c', '1'],
        ['a', '1'],
      ]
      rows.forEach((row, r) => row.forEach((value, c) => model.setUserInput(0, r + 1, c + 1, value)))
    })
    const one = sortOrder(model, { sheet: 0, range: { r0: 1, c0: 1, r1: 4, c1: 2 }, keys: [{ column: 2 }] })
    assert.deepEqual(one.order, [2, 3, 0, 1]) // rows with qty 1 first, in their original order
    sortRange(model, {
      sheet: 0,
      range: { r0: 1, c0: 1, r1: 4, c1: 2 },
      keys: [{ column: 2 }, { column: 1 }],
    })
    assert.deepEqual(readGrid(model, 0, 1, 1, 4, 2), [
      ['a', '1'],
      ['c', '1'],
      ['a', '2'],
      ['b', '2'],
    ])
  })

  it('sorts columns when the axis is transposed', async () => {
    const model = await nodeModel('columns')
    runPaused(model, () => {
      ;['c', 'a', 'b'].forEach((value, index) => model.setUserInput(0, 1, index + 1, value))
      ;[3, 1, 2].forEach((value, index) => model.setUserInput(0, 2, index + 1, String(value)))
    })
    sortRange(model, {
      sheet: 0,
      range: { r0: 1, c0: 1, r1: 2, c1: 3 },
      keys: [{ column: 1 }],
      axis: 'columns',
    })
    assert.deepEqual(readGrid(model, 0, 1, 1, 2, 3), [
      ['a', 'b', 'c'],
      ['1', '2', '3'],
    ])
  })

  it('refuses a key outside the range and a sort with no keys', async () => {
    const model = await workbook()
    assert.throws(() => sortRange(model, { sheet: 0, range: { r0: 1, c0: 1, r1: 5, c1: 2 }, keys: [{ column: 9 }] }))
    assert.throws(() => sortRange(model, { sheet: 0, range: { r0: 1, c0: 1, r1: 5, c1: 2 }, keys: [] }))
  })

  it('reports the sorted rectangle as a structural batch', async () => {
    const model = await workbook()
    const summary = sortRange(model, {
      sheet: 0,
      range: { r0: 1, c0: 1, r1: 5, c1: 4 },
      keys: [{ column: 1 }],
      hasHeader: true,
    })
    assert.equal(summary.structuralKind, 'sort')
    assert.deepEqual(summary.sheetIndexes, [0])
    assert.deepEqual(summary.touched, [{ sheet: 0, r0: 1, c0: 1, r1: 5, c1: 4 }])
    assert.ok(summary.cellCount > 0)
    assert.ok(base.cellContent(0, 2, 1) === 'pear', 'the shared fixture is untouched by the per-test copies')
  })
})
