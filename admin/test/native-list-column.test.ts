import assert from 'node:assert/strict'
import test from 'node:test'

import {
  describeListColumn,
  RETIRED_LIST_COLUMN,
} from '../src/layouts/admin-shell/native-list-column'

test('a described column rounds its viewport rect and keeps its section', () => {
  assert.deepEqual(
    describeListColumn('channels', { left: 0.4, right: 319.6 }),
    { left: 0, right: 320, section: 'channels' },
  )
})

test('the retirement message carries a rect shipped shells will accept', () => {
  // Only `section: null` means anything here — the shell discards the rect.
  // But native builds already in people's hands refuse any list-column message
  // whose rect is not positive-width, and a refused retirement left the iPad's
  // channels creation control floating over knowledge, projects and admin.
  assert.equal(RETIRED_LIST_COLUMN.section, null)
  assert.ok(
    RETIRED_LIST_COLUMN.right > RETIRED_LIST_COLUMN.left,
    'a retirement must survive the shipped shell validator',
  )
})
