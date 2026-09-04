import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createSecretRedactingStream,
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

test('detectSecrets covers quoted assignments, bearer headers, and common secret fields', () => {
  const cases = [
    'Authorization: Bearer abcdefghijklmnopqrstuvwxyz123456',
    'client_secret="abcdefghijklmnopqrstuvwxyz123456"',
    'AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
    "password: 'correct-horse-battery-staple'",
  ]
  for (const value of cases) assert.equal(detectSecrets(value).length, 1, value)
})

test('provider-specific dotted and anthropic credentials are classified as one value', () => {
  const sendgrid = ['SG', 'abcdefghijklmnopqrstuv', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890abcdefg'].join('.')
  const anthropic = ['sk', 'ant', 'aA1_'.repeat(7)].join('-')

  assert.deepEqual(
    detectSecrets(`${sendgrid} ${anthropic}`).map(({ type }) => type),
    ['sendgrid_api_key', 'anthropic_api_key'],
  )
  assert.equal(redactDetectedSecrets(sendgrid), `SG.${'•'.repeat(12)}`)
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
  assert.equal(
    maskSecretValue('Xz9_kLm2Pq7Rs4Tu8Vw1Yz6Ab3Cd5Ef0', 'high_entropy_token'),
    '•'.repeat(12),
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

test('redaction is idempotent and never creates another detected secret', () => {
  const fixtures = [
    'api_key=abcdefghijklmnopqrstuv',
    'password="correct-horse-battery-staple"',
    'Authorization: Bearer abcdefghijklmnopqrstuvwxyz123456',
    'client_secret=abcdefghijklmnopqrstuvwxyz123456,',
  ]
  for (const fixture of fixtures) {
    const redacted = redactDetectedSecrets(fixture)
    assert.equal(redactDetectedSecrets(redacted), redacted)
    assert.equal(detectSecrets(redacted).length, 0)
  }
})

test('assignment extraction excludes surrounding quotes and prose punctuation', () => {
  const quoted = 'password="correct-horse-battery-staple"'
  const punctuated = 'client_secret=abcdefghijklmnopqrstuvwxyz123456,'

  assert.equal(
    extractDetectedSecretValue(quoted, detectSecrets(quoted)[0]!),
    'correct-horse-battery-staple',
  )
  assert.equal(
    extractDetectedSecretValue(punctuated, detectSecrets(punctuated)[0]!),
    'abcdefghijklmnopqrstuvwxyz123456',
  )
})

test('stream redaction holds partial lines and private keys until they are safe', () => {
  const stream = createSecretRedactingStream()
  assert.equal(stream.push('before\napi_key=abc'), 'before\n')
  assert.equal(stream.push('defghijklmnopqrstuv\nafter\n'), `api_key=${'•'.repeat(12)}\nafter\n`)
  assert.equal(stream.finish(), '')

  const pemStream = createSecretRedactingStream()
  assert.equal(pemStream.push('-----BEGIN PRIVATE KEY-----\nabc\n'), '')
  assert.equal(
    pemStream.push('-----END PRIVATE KEY-----\n'),
    `-----BEGIN PRIVATE KEY-----${'•'.repeat(12)}\n`,
  )
})
