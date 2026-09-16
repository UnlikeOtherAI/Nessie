import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import type { SpreadsheetIntent } from '@nessie/schemas'

import { canonicalWorkbook } from '../src/canonical.js'
import type { SpreadsheetEngineModel } from '../src/engine.js'
import type { SpreadsheetStructuralEdit } from '../src/filter.js'
import { createNodeModel } from '../src/node.js'
import { shiftIntent, shiftIntentByEdit, shiftIntents } from '../src/rebase.js'
import { restructure, runPaused } from '../src/write.js'

import { mulberry32 } from './support/engine.js'

// The property the browser's replay depends on: a client whose batch was
// refused for a structural conflict can undo locally, take the foreign batch,
// shift its recorded intents and re-issue them — and land where it would have
// landed if its own edit had won the race.
//
//    apply(foreign) ; apply(shift(intent, foreign))  ≡  apply(intent) ; apply(foreign)
//
// Both sides are run against the real engine and compared with the canonical
// projection, never with `toBytes()`, which is not byte-deterministic.

const ROWS = 12
const COLUMNS = 8

function base(): SpreadsheetEngineModel {
  const model = createNodeModel('rebase')
  runPaused(model, () => {
    for (let row = 1; row <= ROWS; row++) {
      for (let column = 1; column <= COLUMNS; column++) {
        model.setUserInput(0, row, column, `c${row}.${column}`)
      }
    }
  })
  return model
}

function applyEdit(model: SpreadsheetEngineModel, edit: SpreadsheetStructuralEdit): void {
  switch (edit.kind) {
    case 'insertRows':
    case 'deleteRows':
      restructure(model, { kind: edit.kind, sheet: edit.sheet, row: edit.row, count: edit.count })
      return
    case 'insertColumns':
    case 'deleteColumns':
      restructure(model, { kind: edit.kind, sheet: edit.sheet, column: edit.column, count: edit.count })
      return
    case 'moveRows':
    case 'moveColumns':
      restructure(model, {
        kind: edit.kind,
        sheet: edit.sheet,
        start: edit.start,
        count: edit.count,
        delta: edit.delta,
      })
      return
    default:
      throw new Error(`the seeded loop does not generate ${edit.kind}`)
  }
}

function applyIntent(model: SpreadsheetEngineModel, intent: SpreadsheetIntent): void {
  if (intent.kind === 'setUserInput') {
    runPaused(model, () => model.setUserInput(intent.sheet, intent.row, intent.column, intent.value))
    return
  }
  if (intent.kind === 'rangeClearContents') {
    runPaused(model, () => model.rangeClear('contents', intent.sheet, intent.range))
    return
  }
  throw new Error(`the seeded loop does not generate ${intent.kind}`)
}

describe('rebase', () => {
  it('replays 1 000 seeded cell intents across foreign structural batches', () => {
    const random = mulberry32(0xbeef)
    const pickInt = (min: number, max: number) => min + Math.floor(random() * (max - min + 1))
    const failures: string[] = []
    let checkedShifted = 0
    let dropped = 0

    for (let iteration = 0; iteration < 1000; iteration++) {
      const kind = (['insertRows', 'deleteRows', 'insertColumns', 'deleteColumns', 'moveRows', 'moveColumns'] as const)[
        pickInt(0, 5)
      ]!
      let edit: SpreadsheetStructuralEdit
      if (kind === 'insertRows' || kind === 'deleteRows') {
        edit = { kind, sheet: 0, row: pickInt(1, ROWS), count: pickInt(1, 3) }
      } else if (kind === 'insertColumns' || kind === 'deleteColumns') {
        edit = { kind, sheet: 0, column: pickInt(1, COLUMNS), count: pickInt(1, 3) }
      } else {
        const axis = kind === 'moveRows' ? ROWS : COLUMNS
        const count = pickInt(1, 2)
        const start = pickInt(1, axis - count)
        const maxDelta = axis - (start + count - 1)
        const minDelta = 1 - start
        edit = { kind, sheet: 0, start, count, delta: pickInt(minDelta, maxDelta) }
      }

      // Range intents are generated only against insert/delete edits. A move
      // permutes indexes, so a rectangle has no single shifted form and
      // `shiftIntent` refuses it — asserted on its own below.
      const moving = edit.kind === 'moveRows' || edit.kind === 'moveColumns'
      const cellIntent = moving || random() < 0.75
      const row = pickInt(1, ROWS)
      const column = pickInt(1, COLUMNS)
      const intent: SpreadsheetIntent = cellIntent
        ? { kind: 'setUserInput', sheet: 0, row, column, value: `mine-${iteration}` }
        : {
            kind: 'rangeClearContents',
            sheet: 0,
            range: {
              r0: row,
              c0: column,
              r1: Math.min(ROWS, row + pickInt(0, 2)),
              c1: Math.min(COLUMNS, column + pickInt(0, 2)),
            },
          }

      // Path B — the client's edit wins the race.
      const mineFirst = base()
      applyIntent(mineFirst, intent)
      applyEdit(mineFirst, edit)

      // Path A — the foreign batch wins, and the client replays its intent.
      const foreignFirst = base()
      applyEdit(foreignFirst, edit)
      const shifted = shiftIntentByEdit(intent, edit)
      if (shifted) {
        applyIntent(foreignFirst, shifted)
        checkedShifted++
      } else {
        dropped++
      }

      const left = canonicalWorkbook(mineFirst)
      const right = canonicalWorkbook(foreignFirst)
      if (left !== right && failures.length < 5) {
        failures.push(
          `#${iteration} ${JSON.stringify(edit)} vs ${JSON.stringify(intent)} -> ${JSON.stringify(shifted)}`,
        )
      }
    }

    assert.deepEqual(failures, [], `${failures.length} case(s) diverged`)
    assert.ok(checkedShifted > 800, `only ${checkedShifted} intents survived their edit`)
    assert.ok(dropped > 0, 'no case exercised an intent the edit destroyed')
  })

  it('refuses a range intent a move would tear apart, and keeps the two exact cases', () => {
    const clear = (r0: number, r1: number) =>
      ({ kind: 'rangeClearContents', sheet: 0, range: { r0, c0: 1, r1, c1: 3 } }) as const
    const move = { kind: 'moveRows', sheet: 0, start: 4, count: 1, delta: 5 } as const
    // Straddles the moved row: no single rectangle can stand for the result.
    assert.equal(shiftIntentByEdit(clear(3, 6), move), null)
    // Misses the window entirely.
    assert.deepEqual(shiftIntentByEdit(clear(11, 12), move), clear(11, 12))
    // Sits wholly inside the moved block.
    const block = { kind: 'moveRows', sheet: 0, start: 4, count: 3, delta: 5 } as const
    assert.deepEqual(shiftIntentByEdit(clear(4, 6), block), clear(9, 11))
  })

  it('drops an intent whose target row was deleted, and keeps one that was not', () => {
    const intent: SpreadsheetIntent = { kind: 'setUserInput', sheet: 0, row: 5, column: 2, value: 'x' }
    assert.equal(shiftIntentByEdit(intent, { kind: 'deleteRows', sheet: 0, row: 4, count: 3 }), null)
    assert.deepEqual(shiftIntentByEdit(intent, { kind: 'deleteRows', sheet: 0, row: 1, count: 2 }), {
      ...intent,
      row: 3,
    })
    assert.deepEqual(shiftIntentByEdit(intent, { kind: 'insertRows', sheet: 0, row: 1, count: 2 }), {
      ...intent,
      row: 7,
    })
  })

  it('leaves an intent on another sheet alone but re-keys it when sheets move', () => {
    const intent: SpreadsheetIntent = { kind: 'setUserInput', sheet: 2, row: 1, column: 1, value: 'x' }
    assert.deepEqual(shiftIntentByEdit(intent, { kind: 'insertRows', sheet: 0, row: 1, count: 5 }), intent)
    assert.deepEqual(shiftIntentByEdit(intent, { kind: 'deleteSheet', index: 0 }), { ...intent, sheet: 1 })
    assert.equal(shiftIntentByEdit(intent, { kind: 'deleteSheet', index: 2 }), null)
    assert.deepEqual(shiftIntentByEdit(intent, { kind: 'addSheet', index: 0 }), { ...intent, sheet: 3 })
  })

  it('passes undo and redo through untouched', () => {
    const undo: SpreadsheetIntent = { kind: 'undo' }
    assert.deepEqual(shiftIntentByEdit(undo, { kind: 'deleteSheet', index: 0 }), undo)
  })

  it('walks a list of foreign summaries oldest first', () => {
    const summaries = [
      {
        structuralKind: 'insertRows' as const,
        sheetIndexes: [0],
        cellCount: 0,
        touched: [],
        intents: [{ kind: 'insertRows' as const, sheet: 0, row: 1, count: 2 }],
      },
      {
        structuralKind: 'deleteRows' as const,
        sheetIndexes: [0],
        cellCount: 0,
        touched: [],
        intents: [{ kind: 'deleteRows' as const, sheet: 0, row: 1, count: 1 }],
      },
    ]
    const intent: SpreadsheetIntent = { kind: 'setUserInput', sheet: 0, row: 5, column: 1, value: 'x' }
    assert.deepEqual(shiftIntent(intent, summaries), { ...intent, row: 6 })
    assert.deepEqual(shiftIntents([intent, { kind: 'undo' }], summaries).length, 2)
    // A summary with no intents cannot describe an edit, so nothing moves.
    assert.deepEqual(
      shiftIntent(intent, [{ structuralKind: 'insertRows', sheetIndexes: [0], cellCount: 0, touched: [] }]),
      intent,
    )
  })
})
