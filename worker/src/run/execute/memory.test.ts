import assert from 'node:assert/strict'
import test from 'node:test'

import { requiresMemoryDestinationContainment } from './memory.js'

test('a PA in a shared channel is memory-contained while its PA DM is not', () => {
  assert.equal(requiresMemoryDestinationContainment(null, true), true)
  assert.equal(requiresMemoryDestinationContainment('personal_assistant', true), false)
})
