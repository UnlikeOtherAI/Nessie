import assert from 'node:assert/strict'
import test from 'node:test'

import { saveBlockedReason } from '../src/components/features/agents/designer/save-readiness.js'

test('a complete form blocks nothing', () => {
  assert.equal(
    saveBlockedReason({ action: 'create', hasModel: true, hasName: true }),
    null,
  )
  assert.equal(
    saveBlockedReason({ action: 'save', hasModel: true, hasName: true }),
    null,
  )
})

test('each missing field is named, and both are named together', () => {
  assert.equal(
    saveBlockedReason({ action: 'create', hasModel: true, hasName: false }),
    'Add a name to create this agent.',
  )
  assert.equal(
    saveBlockedReason({ action: 'create', hasModel: false, hasName: true }),
    'Pick a model to create this agent.',
  )
  assert.equal(
    saveBlockedReason({ action: 'create', hasModel: false, hasName: false }),
    'Add a name and pick a model to create this agent.',
  )
})

test('editing an existing agent asks to save, not to create', () => {
  assert.equal(
    saveBlockedReason({ action: 'save', hasModel: true, hasName: false }),
    'Add a name to save changes.',
  )
  assert.equal(
    saveBlockedReason({ action: 'save', hasModel: false, hasName: true }),
    'Pick a model to save changes.',
  )
})
