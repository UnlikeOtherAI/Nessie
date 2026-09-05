import assert from 'node:assert/strict'
import test from 'node:test'

import { hmacBase64, hmacHex, secureEquals } from '../src/webhook.js'

test('secureEquals matches identical strings and rejects everything else', () => {
  assert.equal(secureEquals('abc', 'abc'), true)
  assert.equal(secureEquals('abc', 'abd'), false)
  // Different lengths must be false rather than throwing: `timingSafeEqual`
  // refuses unequal buffers, and a signature of the wrong length is simply
  // wrong.
  assert.equal(secureEquals('abc', 'abcd'), false)
  assert.equal(secureEquals('', ''), true)
})

test('the HMAC helpers are stable and algorithm-specific', () => {
  const sha256 = hmacHex('sha256', 'secret', 'payload')
  assert.equal(sha256, hmacHex('sha256', 'secret', 'payload'))
  assert.notEqual(sha256, hmacHex('sha1', 'secret', 'payload'))
  assert.notEqual(sha256, hmacHex('sha256', 'other', 'payload'))
  assert.equal(sha256.length, 64)
  // Trello signs base64 rather than hex, so both encodings are available.
  assert.notEqual(hmacBase64('sha1', 'secret', 'payload'), hmacHex('sha1', 'secret', 'payload'))
})
