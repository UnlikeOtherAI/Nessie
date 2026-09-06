import assert from 'node:assert/strict'
import test from 'node:test'

import {
  defaultGrantedScopes,
  OPT_IN_SCOPES,
} from '../src/facades/agent-access/scope-defaults.js'

// The safety property of the approval screen: an agent that asks for
// publication does not get it by the person clicking Approve without reading.

test('everything asked for is pre-ticked, except publishing', () => {
  assert.deepEqual(
    defaultGrantedScopes(['boards_read', 'boards_write', 'documents_read', 'documents_write']),
    ['boards_read', 'boards_write', 'documents_read', 'documents_write'],
  )
})

test('publishing is never pre-ticked, however confidently it was asked for', () => {
  assert.deepEqual(
    defaultGrantedScopes(['documents_read', 'documents_write', 'documents_publish']),
    ['documents_read', 'documents_write'],
  )
  // Asking for nothing else does not make it the obvious default either.
  assert.deepEqual(defaultGrantedScopes(['documents_publish']), [])
})

test('the opt-in set is exactly the scope that grants publication', () => {
  // If another scope ever becomes this dangerous, it belongs here — and this
  // test is where somebody notices the set changed.
  assert.deepEqual([...OPT_IN_SCOPES], ['documents_publish'])
})
