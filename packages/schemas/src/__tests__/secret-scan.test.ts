import assert from 'node:assert/strict'
import test from 'node:test'

import {
  detectSecrets,
  extractDetectedSecretValue,
  maskSecretValue,
  redactDetectedSecrets,
} from '../secret-scan.js'

test('detectSecrets catches known credential formats without interpreting prose', () => {
  const stripeLikeToken = ['sk', 'live', '1234567890abcdefghijklmnop'].join('_')
  const detected = detectSecrets(`prosim use ${stripeLikeToken} for platby`)
  assert.equal(detected.length, 1)
  assert.equal(detected[0]?.type, 'stripe_api_key')
  assert.equal(
    redactDetectedSecrets(`key=${stripeLikeToken}`),
    `key=sk_live_${'•'.repeat(12)}`,
  )
  assert.doesNotMatch(redactDetectedSecrets(stripeLikeToken), /1234567890/)
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

test('display masks retain only structural provider prefixes', () => {
  assert.equal(
    maskSecretValue('sk-proj-secretbytes', 'openai_api_key'),
    `sk-proj-${'•'.repeat(12)}`,
  )
  assert.equal(
    redactDetectedSecrets('postgresql://admin:really-secret@db.example/nessie'),
    `postgresql://${'•'.repeat(12)}/nessie`,
  )
  assert.equal(
    redactDetectedSecrets('api_key=abcdefghijklmnopqrstuv'),
    `api_key=${'•'.repeat(12)}`,
  )
})

test('explicit assignments save only the credential value', () => {
  const value = ['sk', 'live', '1234567890abcdefghijklmnop'].join('_')
  const content = `api_key=${value}`
  const detected = detectSecrets(content)[0]
  assert.ok(detected)
  const extracted = extractDetectedSecretValue(content, detected)
  assert.equal(extracted, value)
  assert.equal(maskSecretValue(extracted, detected.type), `sk_live_${'•'.repeat(12)}`)
})
