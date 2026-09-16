import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { SpreadsheetBatchSummarySchema } from '@nessie/schemas'

import { SpreadsheetEngineError, type SpreadsheetEngineModel } from '../src/engine.js'
import { createNodeModel } from '../src/node.js'
import { readRange } from '../src/read.js'
import { clearRange, formatRange, manageTabs, restructure, runPaused, writeRange } from '../src/write.js'

function seeded(): SpreadsheetEngineModel {
  const model = createNodeModel('write')
  runPaused(model, () => {
    for (let row = 1; row <= 5; row++) {
      model.setUserInput(0, row, 1, `r${row}`)
      model.setUserInput(0, row, 2, String(row * 2))
    }
  })
  return model
}

describe('write', () => {
  it('writes a block and reports the exact rectangle it touched', () => {
    const model = seeded()
    const summary = writeRange(model, {
      sheet: 0,
      anchor: { row: 2, column: 3 },
      rows: [
        ['a', 1],
        ['b', '=D2*2'],
      ],
    })
    SpreadsheetBatchSummarySchema.parse(summary)
    assert.equal(summary.structuralKind, null)
    assert.equal(summary.cellCount, 4)
    assert.deepEqual(summary.touched, [{ sheet: 0, r0: 2, c0: 3, r1: 3, c1: 4 }])
    assert.deepEqual(readRange(model, 0, { r0: 2, c0: 3, r1: 3, c1: 4 }).values, [
      ['a', '1'],
      ['b', '2'],
    ])
  })

  it('leaves the diffs in the send queue for the caller to flush', () => {
    const model = seeded()
    model.flushSendQueue()
    writeRange(model, { sheet: 0, anchor: { row: 9, column: 9 }, rows: [['x']] })
    // A drained queue still returns one byte (the empty list), never zero.
    assert.ok(model.flushSendQueue().length > 1)
    assert.equal(model.flushSendQueue().length, 1)
  })

  it('refuses a block past maxCellsPerWrite', () => {
    const model = seeded()
    const rows = Array.from({ length: 2000 }, () => Array.from({ length: 10 }, () => 'x'))
    assert.throws(
      () => writeRange(model, { sheet: 0, anchor: { row: 1, column: 1 }, rows }),
      (error: unknown) => error instanceof SpreadsheetEngineError && error.code === 'SPREADSHEET_TOO_LARGE',
    )
  })

  it('formats a range and clears one', () => {
    const model = seeded()
    const summary = formatRange(model, {
      sheet: 0,
      range: { r0: 1, c0: 1, r1: 1, c1: 2 },
      styles: [
        { path: 'font.b', value: 'true' },
        { path: 'num_fmt', value: '#,##0.00' },
      ],
    })
    assert.equal(summary.cellCount, 2)
    assert.equal(model.cellStyle(0, 1, 1).font?.b, true)
    const cleared = clearRange(model, { sheet: 0, range: { r0: 1, c0: 1, r1: 1, c1: 2 }, kind: 'contents' })
    assert.equal(cleared.structuralKind, null)
    assert.equal(model.cellContent(0, 1, 1), '')
    // Contents only: the formatting survives.
    assert.equal(model.cellStyle(0, 1, 1).font?.b, true)
  })

  it('stamps the structural kind on row and column edits, and not on hides or sizes', () => {
    const model = seeded()
    assert.equal(restructure(model, { kind: 'insertRows', sheet: 0, row: 2, count: 3 }).structuralKind, 'insertRows')
    assert.equal(model.cellContent(0, 5, 1), 'r2')
    assert.equal(restructure(model, { kind: 'deleteRows', sheet: 0, row: 2, count: 3 }).structuralKind, 'deleteRows')
    assert.equal(model.cellContent(0, 2, 1), 'r2')
    assert.equal(
      restructure(model, { kind: 'insertColumns', sheet: 0, column: 1, count: 1 }).structuralKind,
      'insertColumns',
    )
    assert.equal(restructure(model, { kind: 'moveRows', sheet: 0, start: 1, count: 2, delta: 2 }).structuralKind, 'moveRows')
    assert.equal(
      restructure(model, { kind: 'setRowsHidden', sheet: 0, start: 1, end: 2, hidden: true }).structuralKind,
      null,
    )
    assert.equal(
      restructure(model, { kind: 'setFrozenRowsCount', sheet: 0, count: 1 }).structuralKind,
      null,
    )
  })

  it('moves rows by cut-and-reinsert, closing the gap behind them', () => {
    const model = createNodeModel('move')
    runPaused(model, () => {
      for (let row = 1; row <= 8; row++) model.setUserInput(0, row, 1, `r${row}`)
    })
    restructure(model, { kind: 'moveRows', sheet: 0, start: 3, count: 2, delta: 3 })
    assert.deepEqual(
      readRange(model, 0, { r0: 1, c0: 1, r1: 8, c1: 1 }).values?.flat(),
      ['r1', 'r2', 'r5', 'r6', 'r7', 'r3', 'r4', 'r8'],
    )
  })

  it('hides a row as height 0, because hidden is not queryable as a boolean', () => {
    const model = seeded()
    assert.equal(model.isRowHidden(0, 2), false)
    restructure(model, { kind: 'setRowsHidden', sheet: 0, start: 2, end: 2, hidden: true })
    assert.equal(model.rowHeight(0, 2), 0)
    assert.equal(model.isRowHidden(0, 2), true)
    restructure(model, { kind: 'setRowsHidden', sheet: 0, start: 2, end: 2, hidden: false })
    assert.equal(model.isRowHidden(0, 2), false)
  })

  it('manages tabs and reports the index a new sheet actually got', () => {
    const model = seeded()
    const added = manageTabs(model, { kind: 'addSheet', name: 'Notes' })
    assert.equal(added.structuralKind, 'addSheet')
    assert.deepEqual(added.sheetIndexes, [1])
    assert.equal(model.sheets()[1]?.name, 'Notes')
    assert.equal(manageTabs(model, { kind: 'renameSheet', sheet: 1, name: 'Memo' }).structuralKind, 'renameSheet')
    assert.equal(manageTabs(model, { kind: 'moveSheet', sheet: 1, toIndex: 0 }).structuralKind, 'moveSheet')
    assert.equal(model.sheets()[0]?.name, 'Memo')
    assert.equal(manageTabs(model, { kind: 'hideSheet', sheet: 0 }).structuralKind, null)
    assert.equal(manageTabs(model, { kind: 'deleteSheet', sheet: 0 }).structuralKind, 'deleteSheet')
  })

  it('refuses a duplicate sheet name, a blank one and the last sheet', () => {
    const model = seeded()
    manageTabs(model, { kind: 'addSheet', name: 'Notes' })
    assert.throws(() => manageTabs(model, { kind: 'renameSheet', sheet: 1, name: 'Sheet1' }), SpreadsheetEngineError)
    assert.throws(() => manageTabs(model, { kind: 'renameSheet', sheet: 1, name: '  ' }), SpreadsheetEngineError)
    manageTabs(model, { kind: 'deleteSheet', sheet: 1 })
    assert.throws(() => manageTabs(model, { kind: 'deleteSheet', sheet: 0 }), SpreadsheetEngineError)
    assert.throws(() => manageTabs(model, { kind: 'renameSheet', sheet: 9, name: 'x' }), SpreadsheetEngineError)
  })
})
