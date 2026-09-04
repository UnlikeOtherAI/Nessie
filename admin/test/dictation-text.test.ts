import assert from 'node:assert/strict'
import test from 'node:test'

import { formatDictationInsertion } from '../src/lib/dictation-text.js'

test('dictation separates words on both sides of the caret', () => {
  assert.equal(formatDictationInsertion('hello', 'there', 'world'), ' there ')
  assert.equal(formatDictationInsertion('hello ', 'there', ' world'), 'there')
})

test('dictation does not add a space before punctuation', () => {
  assert.equal(formatDictationInsertion('hello', 'there', ','), ' there')
})
