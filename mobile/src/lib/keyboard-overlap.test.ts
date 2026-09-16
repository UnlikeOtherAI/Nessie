import assert from 'node:assert/strict'
import test from 'node:test'
import { keyboardOverlapHeight } from './keyboard-overlap'

test('a docked keyboard overlaps the window by the distance to its top edge', () => {
  assert.equal(keyboardOverlapHeight(874, 538.4), 336)
})

test('a keyboard at or below the window bottom does not overlap', () => {
  assert.equal(keyboardOverlapHeight(874, 874), 0)
  assert.equal(keyboardOverlapHeight(874, 1000), 0)
})

test('a malformed keyboard event never moves the frame', () => {
  assert.equal(keyboardOverlapHeight(874, Number.NaN), 0)
  assert.equal(keyboardOverlapHeight(Number.POSITIVE_INFINITY, 500), 0)
})
