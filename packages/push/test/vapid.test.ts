import assert from 'node:assert/strict'
import test from 'node:test'
import { createPublicKey, generateKeyPairSync, verify as cryptoVerify } from 'node:crypto'
import {
  assertValidVapidSubject,
  buildVapidAuthHeader,
  loadVapidPrivateKey,
  mintVapidJwt,
} from '../src/vapid.js'

const decodeSegment = (segment: string): Record<string, unknown> =>
  JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'))

/** Generate a raw Web Push VAPID key pair (base64url), the format browsers use. */
const generateVapidKeys = () => {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  const pubJwk = publicKey.export({ format: 'jwk' }) as { x: string; y: string }
  const privJwk = privateKey.export({ format: 'jwk' }) as { d: string }
  const pub = Buffer.concat([
    Buffer.from([0x04]),
    Buffer.from(pubJwk.x, 'base64url'),
    Buffer.from(pubJwk.y, 'base64url'),
  ])
  return {
    publicKey: pub.toString('base64url'),
    privateKey: Buffer.from(privJwk.d, 'base64url').toString('base64url'),
    publicKeyObject: publicKey,
  }
}

test('loadVapidPrivateKey loads a raw key pair as a P-256 private key', () => {
  const keys = generateVapidKeys()
  const key = loadVapidPrivateKey(keys)
  assert.equal(key.asymmetricKeyType, 'ec')
  assert.equal(key.asymmetricKeyDetails?.namedCurve, 'prime256v1')
})

test('loadVapidPrivateKey rejects a public key of the wrong length', () => {
  assert.throws(
    () => loadVapidPrivateKey({ publicKey: Buffer.alloc(33).toString('base64url'), privateKey: Buffer.alloc(32).toString('base64url') }),
    /65-byte uncompressed/,
  )
})

test('loadVapidPrivateKey rejects a private scalar of the wrong length', () => {
  const keys = generateVapidKeys()
  assert.throws(
    () => loadVapidPrivateKey({ publicKey: keys.publicKey, privateKey: Buffer.alloc(16).toString('base64url') }),
    /32-byte P-256 scalar/,
  )
})

test('mintVapidJwt produces a verifiable ES256 token with aud/exp/sub', () => {
  const keys = generateVapidKeys()
  const key = loadVapidPrivateKey(keys)
  const iat = 1_700_000_000

  const jwt = mintVapidJwt(key, 'https://fcm.googleapis.com', 'mailto:ops@example.com', iat)
  const [headerB64, claimsB64, signatureB64] = jwt.split('.')

  assert.deepEqual(decodeSegment(headerB64), { typ: 'JWT', alg: 'ES256' })
  assert.deepEqual(decodeSegment(claimsB64), {
    aud: 'https://fcm.googleapis.com',
    exp: iat + 12 * 60 * 60,
    sub: 'mailto:ops@example.com',
  })

  const valid = cryptoVerify(
    'sha256',
    Buffer.from(`${headerB64}.${claimsB64}`),
    { key: keys.publicKeyObject, dsaEncoding: 'ieee-p1363' },
    Buffer.from(signatureB64, 'base64url'),
  )
  assert.equal(valid, true)
})

test('mintVapidJwt clamps the expiry to at most 24h', () => {
  const keys = generateVapidKeys()
  const key = loadVapidPrivateKey(keys)
  const iat = 1_700_000_000
  const jwt = mintVapidJwt(key, 'https://example.com', 'mailto:a@b.c', iat, 48 * 60 * 60)
  const claims = decodeSegment(jwt.split('.')[1])
  assert.equal(claims.exp, iat + 24 * 60 * 60)
})

test('buildVapidAuthHeader uses the endpoint origin as aud and the vapid scheme', () => {
  const keys = generateVapidKeys()
  const key = loadVapidPrivateKey(keys)
  const header = buildVapidAuthHeader(
    key,
    { publicKey: keys.publicKey, subject: 'mailto:ops@example.com' },
    'https://updates.push.services.mozilla.com/wpush/v2/abc123',
    1_700_000_000,
  )

  const match = /^vapid t=([^,]+), k=(.+)$/.exec(header)
  assert.ok(match, 'header uses the single-header vapid scheme')
  assert.equal(match![2], keys.publicKey, 'k is the VAPID public key')
  const claims = decodeSegment(match![1].split('.')[1])
  assert.equal(claims.aud, 'https://updates.push.services.mozilla.com', 'aud is the endpoint origin only')

  // The public key in `k` must match the signing key.
  const valid = cryptoVerify(
    'sha256',
    Buffer.from(match![1].split('.').slice(0, 2).join('.')),
    { key: createPublicKey(key), dsaEncoding: 'ieee-p1363' },
    Buffer.from(match![1].split('.')[2], 'base64url'),
  )
  assert.equal(valid, true)
})

test('assertValidVapidSubject enforces mailto:/https: URIs', () => {
  assertValidVapidSubject('mailto:ops@example.com')
  assertValidVapidSubject('https://example.com/contact')
  assert.throws(() => assertValidVapidSubject('ops@example.com'), /mailto:.*https/)
  assert.throws(() => assertValidVapidSubject('http://insecure.example.com'), /mailto:.*https/)
})
