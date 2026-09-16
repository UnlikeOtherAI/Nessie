import assert from 'node:assert/strict'
import test from 'node:test'

import { DEFAULT_BOARD_NAME } from '@nessie/schemas'

import { defaultBoardCreateData } from '../src/index.js'

/**
 * The name a project's first board is born with.
 *
 * "Board" sat directly under the sidebar's "Boards" section and read as a
 * second copy of it rather than as a board, so the default is "Main board".
 * Pinned as a literal here on purpose: every creation path — the create-project
 * route, project creation from chat, the bootstrap seed and the UOA team-target
 * provisioner — goes through `defaultBoardCreateData`, so this one assertion is
 * what stops the name drifting back to the section's own label.
 */

test('a project creates its first board as "Main board"', () => {
  assert.equal(DEFAULT_BOARD_NAME, 'Main board')
  assert.equal(defaultBoardCreateData('00000000-0000-4000-8000-000000000001').name, 'Main board')
})

test('the default board is the project default, first in the strip', () => {
  const data = defaultBoardCreateData('00000000-0000-4000-8000-000000000001')
  assert.equal(data.isDefault, true)
  assert.equal(data.position, 0)
})
