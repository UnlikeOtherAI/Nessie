import assert from 'node:assert/strict'
import test from 'node:test'

import {
  decryptWithKey,
  decryptWithKeyRing,
  deriveSecretKey,
  encryptWithKey,
  encryptWithKeyRing,
} from '../src/secret-crypto.js'

const legacyRoot = 'legacy-at-rest-root'
const firstRoot = 'first-independent-at-rest-root'
const secondRoot = 'second-independent-at-rest-root'

const rotatingRing = {
  activeVersion: '2026-09',
  keys: {
    '2026-06': firstRoot,
    '2026-09': secondRoot,
  },
  legacyKey: legacyRoot,
} as const

test('purpose-aware envelopes survive key rotation and mark retired ciphertext for replacement', () => {
  const oldCiphertext = encryptWithKeyRing(
    { ...rotatingRing, activeVersion: '2026-06' },
    'mcp.oauth',
    'refresh-token',
  )
  const opened = decryptWithKeyRing(rotatingRing, 'mcp.oauth', oldCiphertext)

  assert.equal(opened.plaintext, 'refresh-token')
  assert.equal(opened.keyVersion, '2026-06')
  assert.equal(opened.needsReencryption, true)

  const currentCiphertext = encryptWithKeyRing(rotatingRing, 'mcp.oauth', opened.plaintext)
  const current = decryptWithKeyRing(rotatingRing, 'mcp.oauth', currentCiphertext)
  assert.equal(current.plaintext, 'refresh-token')
  assert.equal(current.keyVersion, '2026-09')
  assert.equal(current.needsReencryption, false)
})

test('legacy auth-root ciphertext remains readable only while the explicit migration root is retained', () => {
  const legacy = encryptWithKey(deriveSecretKey(legacyRoot), 'legacy-token')
  const opened = decryptWithKeyRing(rotatingRing, 'mcp.oauth', legacy)
  assert.equal(opened.plaintext, 'legacy-token')
  assert.equal(opened.keyVersion, null)
  assert.equal(opened.needsReencryption, true)
  assert.throws(
    () => decryptWithKeyRing({ ...rotatingRing, legacyKey: undefined }, 'mcp.oauth', legacy),
    /legacy ciphertext/i,
  )
})

test('ciphertext cannot be replayed into a different encrypted-store purpose', () => {
  const encrypted = encryptWithKeyRing(rotatingRing, 'push.credentials', 'provider-key')
  assert.throws(
    () => decryptWithKeyRing(rotatingRing, 'mcp.oauth', encrypted),
    /purpose/i,
  )
})

test('the purpose key cannot be used as the old generic encryption key', () => {
  const encrypted = encryptWithKeyRing(rotatingRing, 'uoa.refresh', 'opaque-refresh-token')
  assert.throws(
    () => decryptWithKey(deriveSecretKey(secondRoot), encrypted),
  )
})
