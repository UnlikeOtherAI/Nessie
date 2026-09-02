import assert from 'node:assert/strict'
import { createSign, generateKeyPairSync, type KeyObject } from 'node:crypto'
import test from 'node:test'

import { isAllowedSigningCertUrl, parseSnsEnvelope, verifySnsMessage } from '../src/sns.js'

const TOPIC = 'arn:aws:sns:eu-west-1:123456789012:nessie-mail'
const CERT_URL = 'https://sns.eu-west-1.amazonaws.com/SimpleNotificationService-abc123.pem'

// A locally generated key pair stands in for Amazon's certificate: `verify`
// accepts a bare SPKI public key, and the host pin — exercised separately
// below — is what makes the real certificate unforgeable.
const signCanonical = (canonical: string, key: KeyObject): string => {
  const signer = createSign('RSA-SHA256')
  signer.update(canonical, 'utf8')
  return signer.sign(key, 'base64')
}

const buildNotification = (overrides: Record<string, unknown> = {}) => {
  const base = {
    Message: '{"notificationType":"Bounce"}',
    MessageId: '11111111-2222-3333-4444-555555555555',
    Signature: '',
    SignatureVersion: '2',
    SigningCertURL: CERT_URL,
    Timestamp: new Date().toISOString(),
    TopicArn: TOPIC,
    Type: 'Notification',
    ...overrides,
  }
  const canonical = [
    'Message', base.Message,
    'MessageId', base.MessageId,
    'Timestamp', base.Timestamp,
    'TopicArn', base.TopicArn,
    'Type', base.Type,
  ].join('\n') + '\n'
  return { base, canonical }
}

const keyPair = generateKeyPairSync('rsa', { modulusLength: 2048 })
const publicPem = keyPair.publicKey.export({ format: 'pem', type: 'spki' }).toString()

const fetchCertificate = async () => ({ ok: true, text: async () => publicPem })

test('a well-formed, correctly signed notification on the expected topic verifies', async () => {
  const { base, canonical } = buildNotification()
  base.Signature = signCanonical(canonical, keyPair.privateKey)
  const result = await verifySnsMessage({
    expectedTopicArn: TOPIC,
    fetchCertificate,
    rawBody: JSON.stringify(base),
  })
  assert.equal(result.ok, true)
})

test('a message from another topic is refused even when its signature is valid', async () => {
  const other = 'arn:aws:sns:eu-west-1:999999999999:someone-else'
  const { base, canonical } = buildNotification({ TopicArn: other })
  base.Signature = signCanonical(canonical, keyPair.privateKey)
  const result = await verifySnsMessage({
    expectedTopicArn: TOPIC,
    fetchCertificate,
    rawBody: JSON.stringify(base),
  })
  assert.equal(result.ok, false)
  assert.equal(result.ok === false && result.reason, 'topic_mismatch')
})

test('a tampered Message no longer matches the signature', async () => {
  const { base, canonical } = buildNotification()
  base.Signature = signCanonical(canonical, keyPair.privateKey)
  const tampered = { ...base, Message: '{"notificationType":"Complaint"}' }
  const result = await verifySnsMessage({
    expectedTopicArn: TOPIC,
    fetchCertificate,
    rawBody: JSON.stringify(tampered),
  })
  assert.equal(result.ok, false)
  assert.equal(result.ok === false && result.reason, 'signature_invalid')
})

test('SubscriptionConfirmation is refused outright — the API self-subscribes', async () => {
  const { base } = buildNotification({
    SubscribeURL: 'https://sns.eu-west-1.amazonaws.com/?Action=ConfirmSubscription',
    Token: 'abc',
    Type: 'SubscriptionConfirmation',
  })
  const result = await verifySnsMessage({
    expectedTopicArn: TOPIC,
    fetchCertificate,
    rawBody: JSON.stringify(base),
  })
  assert.equal(result.ok, false)
  assert.equal(result.ok === false && result.reason, 'unsupported_type')
})

test('a replayed capture outside the timestamp window is refused', async () => {
  const stale = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString()
  const { base, canonical } = buildNotification({ Timestamp: stale })
  base.Signature = signCanonical(canonical, keyPair.privateKey)
  const result = await verifySnsMessage({
    expectedTopicArn: TOPIC,
    fetchCertificate,
    rawBody: JSON.stringify(base),
  })
  assert.equal(result.ok, false)
  assert.equal(result.ok === false && result.reason, 'stale_timestamp')
})

test('the signing certificate URL is host-pinned to Amazon over https', () => {
  assert.equal(isAllowedSigningCertUrl(CERT_URL), true)
  assert.equal(isAllowedSigningCertUrl('https://evil.example/cert.pem'), false)
  assert.equal(
    isAllowedSigningCertUrl('http://sns.eu-west-1.amazonaws.com/cert.pem'),
    false,
    'plain http must be refused',
  )
  assert.equal(
    isAllowedSigningCertUrl('https://sns.eu-west-1.amazonaws.com.evil.example/cert.pem'),
    false,
    'a suffix-extended host must not match',
  )
  assert.equal(isAllowedSigningCertUrl(undefined), false)
})

test('a certificate URL pointing off-Amazon is refused before any fetch happens', async () => {
  const { base, canonical } = buildNotification({
    SigningCertURL: 'https://evil.example/cert.pem',
  })
  base.Signature = signCanonical(canonical, keyPair.privateKey)
  let fetched = false
  const result = await verifySnsMessage({
    expectedTopicArn: TOPIC,
    fetchCertificate: async () => {
      fetched = true
      return { ok: true, text: async () => publicPem }
    },
    rawBody: JSON.stringify(base),
  })
  assert.equal(result.ok, false)
  assert.equal(result.ok === false && result.reason, 'certificate_url_rejected')
  assert.equal(fetched, false)
})

test('malformed JSON is refused rather than partially interpreted', async () => {
  const result = await verifySnsMessage({
    expectedTopicArn: TOPIC,
    fetchCertificate,
    rawBody: 'not json at all',
  })
  assert.equal(result.ok, false)
  assert.equal(result.ok === false && result.reason, 'malformed')
  assert.equal(parseSnsEnvelope('{"Type":"Notification"}'), null)
})
