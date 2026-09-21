import assert from 'node:assert/strict'
import test from 'node:test'

import { resolveHomeBoardId } from '../src/facades/boards/resolve-home-board'

/**
 * Which board a ticket's labels live on (board-labels-and-attachment-
 * removal.md §8.10): the board it names when the project has it, else the
 * project's default board — what `boardId: null` means on the server — else
 * nothing until there is something to name.
 */

const DEFAULT = { id: 'b-default', isDefault: true }
const DEV = { id: 'b-dev', isDefault: false }

type Case = {
  boardId: string | null | undefined
  boards: { id: string; isDefault: boolean }[] | undefined
  expected: string | null
  name: string
}

const cases: Case[] = [
  { boardId: 'b-dev', boards: [DEFAULT, DEV], expected: 'b-dev', name: 'the named board, when the project has it' },
  { boardId: 'b-default', boards: [DEFAULT, DEV], expected: 'b-default', name: 'the named board, when it is the default' },
  { boardId: 'b-gone', boards: [DEFAULT, DEV], expected: 'b-default', name: 'a board the project no longer has falls to the default' },
  { boardId: null, boards: [DEV, DEFAULT], expected: 'b-default', name: 'no board is the default board, wherever it sits in the list' },
  { boardId: undefined, boards: [DEFAULT], expected: 'b-default', name: 'a create from the backlog lands on the default board' },
  { boardId: 'b-dev', boards: [], expected: null, name: 'no boards: nothing to name' },
  { boardId: 'b-dev', boards: undefined, expected: null, name: 'boards not loaded: nothing yet' },
  { boardId: null, boards: [DEV], expected: null, name: 'no default and no named board: nothing to guess' },
]

for (const { boardId, boards, expected, name } of cases) {
  test(`resolveHomeBoardId: ${name}`, () => {
    assert.equal(resolveHomeBoardId(boards, boardId), expected)
  })
}
