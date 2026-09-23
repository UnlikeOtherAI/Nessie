import assert from 'node:assert/strict'
import test from 'node:test'

import { selectBestPassage, splitPassageMatches } from '../src/lib/highlight-passage.js'

test('splitPassageMatches highlights every literal query term case-insensitively', () => {
  assert.deepEqual(splitPassageMatches('Alpha beta ALPHA', 'alpha beta'), [
    { matched: true, text: 'Alpha' },
    { matched: false, text: ' ' },
    { matched: true, text: 'beta' },
    { matched: false, text: ' ' },
    { matched: true, text: 'ALPHA' },
  ])
})

test('splitPassageMatches highlights a valid two-character autocomplete query', () => {
  assert.deepEqual(splitPassageMatches('Go build', 'go'), [
    { matched: true, text: 'Go' },
    { matched: false, text: ' build' },
  ])
})

test('splitPassageMatches treats regular-expression punctuation literally', () => {
  assert.deepEqual(splitPassageMatches('Use C++ and a.b safely', 'C++ a.b'), [
    { matched: false, text: 'Use ' },
    { matched: true, text: 'C++' },
    { matched: false, text: ' and ' },
    { matched: true, text: 'a.b' },
    { matched: false, text: ' safely' },
  ])
})

test('selectBestPassage chooses ranking metadata without rendering it', () => {
  const selected = selectBestPassage([
    { content: 'lower', score: 0.2 },
    { content: 'higher', score: 0.9 },
  ])
  assert.equal(selected?.content, 'higher')
})
