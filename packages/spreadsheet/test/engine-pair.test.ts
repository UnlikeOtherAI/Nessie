import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { SPREADSHEET_ENGINE_VERSION } from '@nessie/schemas'

import { assertSameWorkbook, canonicalHash, canonicalWorkbook } from '../src/canonical.js'
import type { SpreadsheetEngineModel } from '../src/engine.js'
import { applyDiffsPaused, createNodeModel, loadNodeModel, loadWasmModelForTests } from '../src/node.js'

// The pinned pair must stay honest: @ironcalc/wasm (browser) and
// @ironcalc/nodejs (server) have to converge on the same workbook from the same
// diffs, in both directions, or a person and an agent editing the same document
// would drift apart. This test is the gate on any engine bump.

function build(model: SpreadsheetEngineModel): void {
  model.setUserInput(0, 1, 1, 'Item')
  model.setUserInput(0, 1, 2, 'Qty')
  for (let row = 2; row <= 20; row++) {
    model.setUserInput(0, row, 1, `row ${row}`)
    model.setUserInput(0, row, 2, String(row * 3))
  }
  model.setUserInput(0, 21, 2, '=SUM(B2:B20)')
  model.setUserInput(0, 22, 2, '=IF(B21>500,"big","small")')
  model.updateRangeStyle(0, { r0: 1, c0: 1, r1: 1, c1: 2 }, 'font.b', 'true')
  model.updateRangeStyle(0, { r0: 2, c0: 2, r1: 20, c1: 2 }, 'num_fmt', '#,##0.00')
  model.insertRows(0, 5, 1)
  model.setUserInput(0, 5, 1, 'inserted')
  model.newSheet()
  model.renameSheet(1, 'Second')
  model.setUserInput(1, 1, 1, '=Sheet1!B21*2')
  model.setFrozenRowsCount(0, 1)
}

describe('the pinned IronCalc pair', () => {
  it('converges wasm → node', async () => {
    const source = await loadWasmModelForTests('pair')
    build(source)
    const target = createNodeModel('pair')
    applyDiffsPaused(target, source.flushSendQueue())
    assertSameWorkbook(source, target)
    assert.equal(target.formattedValue(0, 21, 2), source.formattedValue(0, 21, 2))
  })

  it('converges node → wasm', async () => {
    const source = createNodeModel('pair')
    build(source)
    const target = await loadWasmModelForTests('pair')
    applyDiffsPaused(target, source.flushSendQueue())
    assertSameWorkbook(source, target)
  })

  it('carries a workbook between the two versions as bytes', async () => {
    const source = createNodeModel('bytes')
    build(source)
    const roundTripped = loadNodeModel(source.toBytes())
    assertSameWorkbook(source, roundTripped)
    assert.equal(canonicalHash(source), canonicalHash(roundTripped))
  })

  it('pins the engine version the rest of the system stamps', () => {
    assert.equal(SPREADSHEET_ENGINE_VERSION, '0.8.3')
  })

  it('applies a long journal in order and lands where a single model would', async () => {
    const authority = createNodeModel('journal')
    const replica = createNodeModel('journal')
    const journal: Uint8Array[] = []
    for (let round = 0; round < 20; round++) {
      const client = round % 2 === 0 ? createNodeModel('journal') : await loadWasmModelForTests('journal')
      // every client starts from the authority's current state
      replay(client, journal)
      client.setUserInput(0, round + 1, 1, `edit ${round}`)
      const diffs = client.flushSendQueue()
      journal.push(diffs)
      applyDiffsPaused(authority, diffs)
    }
    replay(replica, journal)
    assertSameWorkbook(authority, replica)
    assert.equal(canonicalWorkbook(authority).split('\n').length, 21)
  })
})

/** The engine takes one payload at a time, so a journal is replayed in order —
 *  the order is the truth, as applying the same batches in another order
 *  diverges. */
function replay(model: SpreadsheetEngineModel, journal: readonly Uint8Array[]): void {
  model.pauseEvaluation()
  try {
    for (const diffs of journal) model.applyExternalDiffs(diffs)
  } finally {
    model.resumeEvaluation()
  }
  model.evaluate()
}
