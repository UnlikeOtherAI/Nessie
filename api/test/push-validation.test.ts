import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import test from 'node:test'

import {
  deriveApnsKeyIdFromFilename,
  mintApnsJwt,
  parseFcmServiceAccount,
  PushValidationError,
  PUSH_VALIDATION_ERROR_CODES,
} from '../src/services/push-validation.js'

/**
 * Validation unit tests for the push-credentials surface. The live FCM token
 * exchange is NOT exercised here (network); it is injected/mocked in the
 * service test instead. APNs uses a freshly generated P-256 EC key so the test
 * carries no real Apple secret.
 */

const generateP8 = (): string => {
  const { privateKey } = crypto.generateKeyPairSync('ec', {
    namedCurve: 'P-256',
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  })
  return privateKey as string
}

const decodeJoseSegment = (segment: string): Record<string, unknown> =>
  JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'))

test('mintApnsJwt produces a verifiable ES256 JWT from a valid .p8', () => {
  const p8 = generateP8()
  const jwt = mintApnsJwt({ p8, keyId: 'ABC123KEYID', teamId: 'TEAM123456' })

  const [header, payload, signature] = jwt.split('.')
  assert.ok(header && payload && signature)

  const decodedHeader = decodeJoseSegment(header)
  assert.equal(decodedHeader['alg'], 'ES256')
  assert.equal(decodedHeader['kid'], 'ABC123KEYID')

  const decodedPayload = decodeJoseSegment(payload)
  assert.equal(decodedPayload['iss'], 'TEAM123456')
  assert.equal(typeof decodedPayload['iat'], 'number')

  // The signature must verify against the key's public half (proves real signing).
  const publicKey = crypto.createPublicKey({ key: p8, format: 'pem' })
  const verified = crypto.verify(
    'SHA256',
    Buffer.from(`${header}.${payload}`),
    { key: publicKey, dsaEncoding: 'ieee-p1363' },
    Buffer.from(signature, 'base64url'),
  )
  assert.equal(verified, true)
})

test('mintApnsJwt rejects a non-PEM / garbage key', () => {
  assert.throws(
    () => mintApnsJwt({ p8: 'not a real key', keyId: 'K', teamId: 'T' }),
    (error: unknown) =>
      error instanceof PushValidationError
      && error.code === PUSH_VALIDATION_ERROR_CODES.APNS_KEY_INVALID,
  )
})

test('mintApnsJwt rejects an RSA key (not EC, cannot ES256-sign)', () => {
  const { privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  })
  assert.throws(
    () => mintApnsJwt({ p8: privateKey as string, keyId: 'K', teamId: 'T' }),
    (error: unknown) =>
      error instanceof PushValidationError
      && error.code === PUSH_VALIDATION_ERROR_CODES.APNS_KEY_INVALID,
  )
})

test('deriveApnsKeyIdFromFilename extracts the Key ID from AuthKey_<KEYID>.p8', () => {
  assert.equal(deriveApnsKeyIdFromFilename('AuthKey_ABC123XYZ9.p8'), 'ABC123XYZ9')
  assert.equal(deriveApnsKeyIdFromFilename('authkey_abc123.p8'), 'abc123')
})

test('deriveApnsKeyIdFromFilename returns null for non-canonical names', () => {
  assert.equal(deriveApnsKeyIdFromFilename('mykey.p8'), null)
  assert.equal(deriveApnsKeyIdFromFilename(undefined), null)
  assert.equal(deriveApnsKeyIdFromFilename('AuthKey_ABC.pem'), null)
})

const validFcmJson = (overrides: Record<string, unknown> = {}): string =>
  JSON.stringify({
    type: 'service_account',
    project_id: 'my-firebase-project',
    client_email: 'svc@my-firebase-project.iam.gserviceaccount.com',
    private_key: '-----BEGIN PRIVATE KEY-----\nMII...\n-----END PRIVATE KEY-----\n',
    ...overrides,
  })

test('parseFcmServiceAccount accepts a well-formed service account', () => {
  const account = parseFcmServiceAccount(validFcmJson())
  assert.equal(account.project_id, 'my-firebase-project')
  assert.equal(account.client_email, 'svc@my-firebase-project.iam.gserviceaccount.com')
})

test('parseFcmServiceAccount rejects non-JSON', () => {
  assert.throws(
    () => parseFcmServiceAccount('{ not json'),
    (error: unknown) =>
      error instanceof PushValidationError
      && error.code === PUSH_VALIDATION_ERROR_CODES.FCM_JSON_INVALID,
  )
})

test('parseFcmServiceAccount rejects the wrong type', () => {
  assert.throws(
    () => parseFcmServiceAccount(validFcmJson({ type: 'authorized_user' })),
    (error: unknown) =>
      error instanceof PushValidationError
      && error.code === PUSH_VALIDATION_ERROR_CODES.FCM_JSON_INVALID,
  )
})

test('parseFcmServiceAccount rejects a missing required field', () => {
  assert.throws(
    () => parseFcmServiceAccount(validFcmJson({ client_email: undefined })),
    (error: unknown) =>
      error instanceof PushValidationError
      && error.code === PUSH_VALIDATION_ERROR_CODES.FCM_JSON_INVALID,
  )
})
