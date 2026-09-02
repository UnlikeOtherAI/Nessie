import assert from 'node:assert/strict'
import test from 'node:test'

import { SUPERSEDABLE_APP_CONNECTION_REQUEST_STATUSES } from './app-setup.js'

test('a later offer cannot supersede an OAuth or App Management decision in progress', () => {
  assert.deepEqual(SUPERSEDABLE_APP_CONNECTION_REQUEST_STATUSES, [
    'offered',
    'needs_secret',
    'selecting_resources',
    'awaiting_scope_upgrade',
  ])
})
