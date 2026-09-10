import assert from 'node:assert/strict'
import test from 'node:test'

import { ApiClientError } from '@nessie/client-core'

import { isInvalidTaskSearchCursor } from '../src/facades/search/hooks.js'

test('only the expired task-search cursor error offers a search restart', () => {
  assert.equal(
    isInvalidTaskSearchCursor(new ApiClientError('Invalid task search cursor', 'TASK_SEARCH_CURSOR_INVALID', 400)),
    true,
  )
  assert.equal(isInvalidTaskSearchCursor(new ApiClientError('Forbidden', 'FORBIDDEN', 403)), false)
  assert.equal(isInvalidTaskSearchCursor(new Error('Invalid task search cursor')), false)
})
