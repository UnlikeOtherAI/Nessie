import assert from 'node:assert/strict'
import test from 'node:test'
import {
  DEFAULT_BOARD_VIEW,
  parseBoardView,
} from '../src/components/features/projects/kanban/board-view'

test('a board without a view param draws full cards', () => {
  assert.equal(DEFAULT_BOARD_VIEW, 'cards')
  assert.equal(parseBoardView(null), 'cards')
  assert.equal(parseBoardView(''), 'cards')
})

test('?view=lines draws title-and-priority rows', () => {
  assert.equal(parseBoardView('lines'), 'lines')
})

test('an unknown or hand-edited view falls back to cards', () => {
  assert.equal(parseBoardView('cards'), 'cards')
  assert.equal(parseBoardView('LINES'), 'cards')
  assert.equal(parseBoardView('list'), 'cards')
})
