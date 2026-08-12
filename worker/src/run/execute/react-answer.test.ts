import assert from 'node:assert/strict'
import test from 'node:test'

import { isContentlessAfterReacting } from './working-marker.js'

/**
 * A run that answers with a reaction must not also post its leftover text.
 * The structural half (did it call `react`) does the real work; the text half
 * only asks whether the words carry information, never what they mean.
 */

test('a reaction plus a bare emoji is the reaction alone', () => {
  assert.equal(isContentlessAfterReacting(true, '👍'), true)
  assert.equal(isContentlessAfterReacting(true, ' 👍 '), true)
  assert.equal(isContentlessAfterReacting(true, '👍🎉'), true)
  assert.equal(isContentlessAfterReacting(true, '.'), true)
  assert.equal(isContentlessAfterReacting(true, ''), true)
})

test('a reaction plus real words is still a message worth posting', () => {
  assert.equal(isContentlessAfterReacting(true, '👍 already restarted it'), false)
  assert.equal(isContentlessAfterReacting(true, 'ok'), false)
  assert.equal(isContentlessAfterReacting(true, 'hotovo'), false)
  assert.equal(isContentlessAfterReacting(true, '收到'), false)
  assert.equal(isContentlessAfterReacting(true, '2 devices down'), false)
})

test('without a reaction nothing is suppressed, whatever the text', () => {
  assert.equal(isContentlessAfterReacting(false, '👍'), false)
  assert.equal(isContentlessAfterReacting(false, ''), false)
})
