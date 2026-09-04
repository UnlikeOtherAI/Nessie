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

test('credentials carrying no provider prefix are caught in every common encoding', () => {
  const hex = '9f8e7d6c5b4a39281706f5e4d3c2b1a09f8e7d6c5b4a392817'
  const base64Url = ['QWxhZGRpbjpvcGVu', 'c2VzYW1l_abcDEF123456789xyz'].join('-')
  const base64 = 'QWxhZGRpbjpvcGVuIHNlc2FtZQ+abc/def'

  for (const credential of [hex, base64Url, base64]) {
    const detected = detectSecrets(`tok ${credential} end`)
    assert.equal(detected.length, 1, credential)
    assert.equal(detected[0]?.type, 'high_entropy_token', credential)
    assert.doesNotMatch(redactDetectedSecrets(`tok ${credential} end`), /•{12}[A-Za-z0-9]{8}/)
  }
})

test('identifiers that merely look random are never redacted', () => {
  // Every Nessie primary key is a UUID, a git object name is public, and a
  // labelled digest is content addressing. Redacting any of them would break
  // the id resolution the agent system prompt requires.
  const safe = [
    'agentId 3f8a1c2e-9b7d-4e6f-a1b2-c3d4e5f6a7b8 bound',
    'commit 1bb09ee8a6bf9325c81218a77944238e783d5a6c merged',
    'digest sha256:9f8e7d6c5b4a39281706f5e4d3c2b1a09f8e7d6c5b4a3928170612ab34cd56ef',
    'see https://cdn.example.com/assets/build/main.a1b2c3d4e5f6a7b8.chunk.js',
    'call getUserAccountSettingsFromDatabaseNow() here',
  ]

  for (const sample of safe) {
    assert.deepEqual(detectSecrets(sample), [], sample)
    assert.equal(redactDetectedSecrets(sample), sample, sample)
  }
})

test('a specific provider outranks the generic rule that also matches it', () => {
  const anthropic = ['sk', 'ant', 'api03', 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789'].join('-')
  const detected = detectSecrets(`key ${anthropic} end`)

  assert.equal(detected.length, 1)
  assert.equal(detected[0]?.type, 'anthropic_api_key')
  assert.match(redactDetectedSecrets(`key ${anthropic} end`), /key sk-ant-•{12} end/)
})

test('credentials wearing the shapes tool results actually carry are detected', () => {
  // HTTP headers, JSON config and .env dumps are what reaches a run through a
  // tool result; each of these went undetected while the separator grammar
  // demanded bare whitespace or an unquoted value.
  for (const sample of [
    'Authorization: Bearer abcdefghijklmnopqrstuvwx',
    'password = "hunter2hunter2hunter2"',
    '{"api_key": "abcdefghijklmnopqr"}',
  ]) {
    assert.equal(detectSecrets(sample).length, 1, sample)
    assert.doesNotMatch(redactDetectedSecrets(sample), /hunter2hunter2|abcdefghijklmnopqr/, sample)
  }
})

test('a document id inside a URL path survives, a credential in its query does not', () => {
  const documentLink = 'https://docs.google.com/document/d/1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms/edit'
  assert.equal(redactDetectedSecrets(documentLink), documentLink)

  const withCredential = `https://api.example.com/v1/items?api_key=${'A1b2C3d4E5f6G7h8'}`
  assert.doesNotMatch(redactDetectedSecrets(withCredential), /A1b2C3d4E5f6G7h8/)
})

test('the assignment grammar stays linear on a pathological whitespace run', () => {
  // `\s*` nested over `\s+` made this quadratic: 120k spaces took ~6s, and
  // uploads are scanned on the request thread up to MESSAGE_UPLOAD_MAX_BYTES.
  const started = Date.now()
  detectSecrets(`password${' '.repeat(120_000)}`)
  assert.ok(Date.now() - started < 500, 'scanning a whitespace run must not backtrack quadratically')
})
