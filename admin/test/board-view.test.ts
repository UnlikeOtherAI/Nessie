import assert from 'node:assert/strict'
import test from 'node:test'
import {
  BOARD_VIEWS,
  DEFAULT_BOARD_VIEW,
} from '../src/components/features/projects/kanban/board-view'

test('a board opens on full cards, so a URL without ?view keeps today’s board', () => {
  assert.equal(DEFAULT_BOARD_VIEW, 'cards')
})

test('the view strip offers exactly cards and lines', () => {
  assert.deepEqual([...BOARD_VIEWS], ['cards', 'lines'])
  assert.ok(BOARD_VIEWS.includes(DEFAULT_BOARD_VIEW))
})
