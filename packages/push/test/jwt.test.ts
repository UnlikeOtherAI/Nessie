import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createVerify,
  generateKeyPairSync,
  verify as cryptoVerify,
} from 'node:crypto'
import { buildServiceAccountJwt, loadApnsKey, mintApnsJwt } from '../src/jwt.js'

const decodeSegment = (segment: string): Record<string, unknown> =>
  JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'))

test('loadApnsKey accepts a P-256 EC key', () => {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string
  const key = loadApnsKey(pem)
  assert.equal(key.asymmetricKeyType, 'ec')
})

test('loadApnsKey rejects a non-P-256 EC key', () => {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'secp384r1' })
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string
  assert.throws(() => loadApnsKey(pem), /P-256/)
})

test('loadApnsKey rejects an RSA key', () => {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string
  assert.throws(() => loadApnsKey(pem), /must be an EC key/)
})

test('loadApnsKey rejects garbage', () => {
  assert.throws(() => loadApnsKey('not a key'), /could not be parsed/)
})

test('mintApnsJwt produces a verifiable ES256 token with the right header/claims', () => {
  const { privateKey, publicKey } = generateKeyPairSync('ec', {
    namedCurve: 'prime256v1',
  })
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string
  const key = loadApnsKey(pem)

  const iat = 1_700_000_000
  const jwt = mintApnsJwt(key, 'KEY123', 'TEAM456', iat)
  const [headerB64, claimsB64, signatureB64] = jwt.split('.')

  assert.deepEqual(decodeSegment(headerB64), { alg: 'ES256', kid: 'KEY123' })
  assert.deepEqual(decodeSegment(claimsB64), { iss: 'TEAM456', iat })

  const signingInput = Buffer.from(`${headerB64}.${claimsB64}`)
  const signature = Buffer.from(signatureB64, 'base64url')
  const valid = cryptoVerify('sha256', signingInput, {
    key: publicKey,
    dsaEncoding: 'ieee-p1363',
  }, signature)
  assert.equal(valid, true)
})

test('buildServiceAccountJwt produces a verifiable RS256 assertion', () => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
  })
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string

  const iat = 1_700_000_000
  const jwt = buildServiceAccountJwt(
    pem,
    'svc@example.iam.gserviceaccount.com',
    'https://oauth2.googleapis.com/token',
    'https://www.googleapis.com/auth/firebase.messaging',
    iat,
  )
  const [headerB64, claimsB64, signatureB64] = jwt.split('.')

  assert.deepEqual(decodeSegment(headerB64), { alg: 'RS256', typ: 'JWT' })
  assert.deepEqual(decodeSegment(claimsB64), {
    iss: 'svc@example.iam.gserviceaccount.com',
    scope: 'https://www.googleapis.com/auth/firebase.messaging',
    aud: 'https://oauth2.googleapis.com/token',
    iat,
    exp: iat + 3600,
  })

  const verifier = createVerify('RSA-SHA256')
  verifier.update(`${headerB64}.${claimsB64}`)
  verifier.end()
  const valid = verifier.verify(publicKey, Buffer.from(signatureB64, 'base64url'))
  assert.equal(valid, true)
})
