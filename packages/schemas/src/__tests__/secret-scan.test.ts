import assert from 'node:assert/strict'
import test from 'node:test'

import { detectSecrets, redactDetectedSecrets } from '../secret-scan.js'

test('detectSecrets catches known credential formats without interpreting prose', () => {
  const stripeLikeToken = ['sk', 'live', '1234567890abcdefghijklmnop'].join('_')
  const detected = detectSecrets(`prosim use ${stripeLikeToken} for platby`)
  assert.equal(detected.length, 1)
  assert.equal(detected[0]?.type, 'stripe_api_key')
  assert.match(redactDetectedSecrets(`key=${stripeLikeToken}`), /••••/)
})

test('detectSecrets catches private key blocks and database URLs', () => {
  assert.equal(detectSecrets('-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----').length, 1)
  assert.equal(detectSecrets('postgresql://admin:really-secret@db.example/nessie').length, 1)
})

test('detectSecrets catches common provider prefixes and unprefixed high-entropy tokens', () => {
  const detected = detectSecrets('glpat-abcdefghijklmnopqrstuvwxyz123456 Xz9_kLm2Pq7Rs4Tu8Vw1Yz6Ab3Cd5Ef0')
  assert.equal(detected.length, 2)
  assert.equal(detected[0]?.type, 'github_token')
  assert.equal(detected[1]?.type, 'high_entropy_token')
})
