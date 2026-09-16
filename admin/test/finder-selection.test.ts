import assert from 'node:assert/strict'
import test from 'node:test'
import {
  clickModifier,
  emptyFinderSelection,
  finderSelectionReducer,
  isRowSelected,
  type FinderSelection,
  type FinderSelectionEvent,
} from '../src/components/features/knowledge/finder/finder-selection'

/**
 * The selection model (browser-ui.md §7). Every case here is one a person can
 * feel: a Shift range that creeps behind the pointer, a Cmd-click that clears
 * the four rows you had, a toolbar still acting on a row that was deleted
 * under it.
 */

const ORDER = ['a', 'b', 'c', 'd', 'e']
const COLUMN = 'folder:1'

const run = (events: FinderSelectionEvent[], from = emptyFinderSelection(COLUMN)): FinderSelection =>
  events.reduce(finderSelectionReducer, from)

const click = (
  id: string,
  modifier: 'none' | 'toggle' | 'range' = 'none',
  columnKey = COLUMN,
): FinderSelectionEvent => ({ columnKey, id, modifier, order: ORDER, type: 'click' })

test('a plain click selects exactly one row and anchors there', () => {
  const state = run([click('c')])
  assert.deepEqual(state.ids, ['c'])
  assert.equal(state.anchorId, 'c')
  assert.equal(state.columnKey, COLUMN)
})

test('Cmd-click adds and removes, keeping the column’s own order', () => {
  const state = run([click('d'), click('b', 'toggle')])
  assert.deepEqual(state.ids, ['b', 'd'])
  assert.deepEqual(run([click('d'), click('b', 'toggle'), click('d', 'toggle')]).ids, ['b'])
})

test('Shift-click selects the range and does not move the anchor', () => {
  const first = run([click('b'), click('d', 'range')])
  assert.deepEqual(first.ids, ['b', 'c', 'd'])
  assert.equal(first.anchorId, 'b')

  // A second Shift-click re-measures from the same anchor rather than from
  // wherever the last one landed.
  const second = finderSelectionReducer(first, click('a', 'range'))
  assert.deepEqual(second.ids, ['a', 'b'])
  assert.equal(second.anchorId, 'b')
})

test('a modified click in another column replaces rather than extends', () => {
  const state = run([click('b'), click('d', 'range'), click('a', 'toggle', 'folder:2')])
  assert.equal(state.columnKey, 'folder:2')
  assert.deepEqual(state.ids, ['a'])
})

test('arrow keys walk, and Shift extends from the anchor', () => {
  const down = run([click('b'), { columnKey: COLUMN, extend: false, order: ORDER, step: 1, type: 'step' }])
  assert.deepEqual(down.ids, ['c'])

  const extended = run([
    click('b'),
    { columnKey: COLUMN, extend: true, order: ORDER, step: 1, type: 'step' },
    { columnKey: COLUMN, extend: true, order: ORDER, step: 1, type: 'step' },
  ])
  assert.deepEqual(extended.ids, ['b', 'c', 'd'])
})

test('arrowing into a column with nothing selected lands at the near end', () => {
  const down = run([{ columnKey: COLUMN, extend: false, order: ORDER, step: 1, type: 'step' }])
  assert.deepEqual(down.ids, ['a'])
  const up = run([{ columnKey: COLUMN, extend: false, order: ORDER, step: -1, type: 'step' }])
  assert.deepEqual(up.ids, ['e'])
})

test('Home and End do not run off the ends', () => {
  assert.deepEqual(
    run([click('c'), { columnKey: COLUMN, extend: false, order: ORDER, step: 'end', type: 'step' }]).ids,
    ['e'],
  )
  assert.deepEqual(
    run([click('c'), { columnKey: COLUMN, extend: false, order: ORDER, step: 'home', type: 'step' }]).ids,
    ['a'],
  )
  // Stepping past the last row stays on it rather than wrapping to the first.
  assert.deepEqual(
    run([click('e'), { columnKey: COLUMN, extend: false, order: ORDER, step: 1, type: 'step' }]).ids,
    ['e'],
  )
})

test('opening a folder makes its column active with nothing selected', () => {
  const state = run([click('b'), { columnKey: 'folder:2', type: 'enterColumn' }])
  assert.equal(state.columnKey, 'folder:2')
  assert.deepEqual(state.ids, [])
})

test('reconcile drops rows that no longer exist and keeps the rest', () => {
  const selected = run([click('b'), click('d', 'range')])
  const after = finderSelectionReducer(selected, {
    columnKey: COLUMN,
    order: ['a', 'b', 'e'],
    type: 'reconcile',
  })
  assert.deepEqual(after.ids, ['b'])
  assert.equal(after.anchorId, 'b')
})

test('reconcile with no change returns the same object, so nothing re-renders', () => {
  const selected = run([click('b')])
  const again = finderSelectionReducer(selected, { columnKey: COLUMN, order: ORDER, type: 'reconcile' })
  assert.equal(again, selected)
})

test('reconcile ignores a column that is not the active one', () => {
  const selected = run([click('b')])
  const other = finderSelectionReducer(selected, {
    columnKey: 'folder:9',
    order: [],
    type: 'reconcile',
  })
  assert.equal(other, selected)
})

test('a column that is not active paints the path row instead', () => {
  const selection = run([click('b')])
  assert.equal(isRowSelected(selection, COLUMN, 'b'), true)
  assert.equal(isRowSelected(selection, 'folder:0', 'x', 'x'), true)
  assert.equal(isRowSelected(selection, 'folder:0', 'y', 'x'), false)
})

test('the modifiers are the ones a file browser uses', () => {
  assert.equal(clickModifier({ ctrlKey: false, metaKey: false, shiftKey: false }), 'none')
  assert.equal(clickModifier({ ctrlKey: false, metaKey: true, shiftKey: false }), 'toggle')
  assert.equal(clickModifier({ ctrlKey: true, metaKey: false, shiftKey: false }), 'toggle')
  // Shift wins: a Cmd-Shift-click extends, it does not toggle one row.
  assert.equal(clickModifier({ ctrlKey: false, metaKey: true, shiftKey: true }), 'range')
})
