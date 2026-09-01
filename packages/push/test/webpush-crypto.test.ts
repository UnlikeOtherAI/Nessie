import assert from 'node:assert/strict'
import test from 'node:test'
import { createDecipheriv, createECDH, hkdfSync } from 'node:crypto'
import { encryptWebPushPayload } from '../src/webpush-crypto.js'

/**
 * Independent RFC 8291 decryption — the inverse of encryptWebPushPayload, hand
 * written here from the spec so a round-trip is a genuine cross-check (encrypt
 * and decrypt do not share code). If the library's ciphertext decrypts back to
 * the exact plaintext, the ECDH → HKDF → AES128GCM chain and the RFC 8188 wire
 * framing are all correct.
 */
const KEY_LABEL = Buffer.concat([Buffer.from('WebPush: info'), Buffer.from([0])])
const CEK_INFO = Buffer.concat([Buffer.from('Content-Encoding: aes128gcm'), Buffer.from([0])])
const NONCE_INFO = Buffer.concat([Buffer.from('Content-Encoding: nonce'), Buffer.from([0])])

const hkdf = (ikm: Buffer, salt: Buffer, info: Buffer, len: number): Buffer =>
  Buffer.from(hkdfSync('sha256', ikm, salt, info, len))

const decrypt = (body: Buffer, uaEcdh: ReturnType<typeof createECDH>, uaPublic: Buffer, auth: Buffer): Buffer => {
  const salt = body.subarray(0, 16)
  const idlen = body.readUInt8(20)
  const asPublic = body.subarray(21, 21 + idlen)
  const ciphertext = body.subarray(21 + idlen)

  const shared = uaEcdh.computeSecret(asPublic)
  const keyInfo = Buffer.concat([KEY_LABEL, uaPublic, asPublic])
  const ikm = hkdf(shared, auth, keyInfo, 32)
  const cek = hkdf(ikm, salt, CEK_INFO, 16)
  const nonce = hkdf(ikm, salt, NONCE_INFO, 12)

  const tag = ciphertext.subarray(ciphertext.length - 16)
  const data = ciphertext.subarray(0, ciphertext.length - 16)
  const decipher = createDecipheriv('aes-128-gcm', cek, nonce)
  decipher.setAuthTag(tag)
  const record = Buffer.concat([decipher.update(data), decipher.final()])
  // Strip the RFC 8188 last-record delimiter (0x02) and any zero padding.
  let end = record.length - 1
  while (end >= 0 && record[end] === 0x00) end -= 1
  assert.equal(record[end], 0x02, 'record must end with the 0x02 last-record delimiter')
  return record.subarray(0, end)
}

const newSubscription = () => {
  const ecdh = createECDH('prime256v1')
  const p256dh = ecdh.generateKeys()
  const auth = Buffer.from('0123456789abcdef', 'utf8') // exactly 16 bytes
  return { ecdh, p256dh, auth }
}

test('round-trips an encrypted payload back to the original plaintext', () => {
  const { ecdh, p256dh, auth } = newSubscription()
  const plaintext = Buffer.from('When I grow up, I want to be a watermelon', 'utf8')

  const body = encryptWebPushPayload({ payload: plaintext, uaPublicKey: p256dh, authSecret: auth })
  const recovered = decrypt(body, ecdh, p256dh, auth)

  assert.deepEqual(recovered, plaintext)
})

test('round-trips a realistic JSON notification payload', () => {
  const { ecdh, p256dh, auth } = newSubscription()
  const plaintext = Buffer.from(
    JSON.stringify({ title: 'New message', body: 'Hello 👋 — quotes "and" emoji', data: { url: '/channels/abc' } }),
    'utf8',
  )
  const body = encryptWebPushPayload({ payload: plaintext, uaPublicKey: p256dh, authSecret: auth })
  assert.deepEqual(decrypt(body, ecdh, p256dh, auth), plaintext)
})

test('body framing: salt(16) | rs(4) | idlen(1)=65 | as_public(65) | ciphertext', () => {
  const { p256dh, auth } = newSubscription()
  const body = encryptWebPushPayload({ payload: Buffer.from('hi'), uaPublicKey: p256dh, authSecret: auth })

  assert.equal(body.readUInt32BE(16), 4096, 'record size header')
  assert.equal(body.readUInt8(20), 65, 'key id length is the 65-byte ephemeral public key')
  assert.equal(body[21], 0x04, 'ephemeral key is an uncompressed point')
  // header(21) + as_public(65) + plaintext(2) + delimiter(1) + tag(16) = 105
  assert.equal(body.length, 21 + 65 + 2 + 1 + 16)
})

test('each call uses a fresh ephemeral key + salt (ciphertext is non-deterministic)', () => {
  const { p256dh, auth } = newSubscription()
  const input = { payload: Buffer.from('same'), uaPublicKey: p256dh, authSecret: auth }
  const a = encryptWebPushPayload(input)
  const b = encryptWebPushPayload(input)
  assert.notDeepEqual(a, b)
  assert.notDeepEqual(a.subarray(0, 16), b.subarray(0, 16), 'salt differs')
  assert.notDeepEqual(a.subarray(21, 86), b.subarray(21, 86), 'ephemeral public key differs')
})

test('rejects a malformed p256dh key', () => {
  assert.throws(
    () => encryptWebPushPayload({ payload: Buffer.from('x'), uaPublicKey: Buffer.alloc(10), authSecret: Buffer.alloc(16) }),
    /65-byte uncompressed/,
  )
})

test('round-trips an empty payload', () => {
  const { ecdh, p256dh, auth } = newSubscription()
  const body = encryptWebPushPayload({ payload: Buffer.alloc(0), uaPublicKey: p256dh, authSecret: auth })
  assert.deepEqual(decrypt(body, ecdh, p256dh, auth), Buffer.alloc(0))
})

test('rejects a payload too large for a single record', () => {
  const { p256dh, auth } = newSubscription()
  assert.throws(
    () => encryptWebPushPayload({ payload: Buffer.alloc(4080), uaPublicKey: p256dh, authSecret: auth }),
    /payload too large/,
  )
})

test('rejects a wrong-length auth secret', () => {
  const { p256dh } = newSubscription()
  assert.throws(
    () => encryptWebPushPayload({ payload: Buffer.from('x'), uaPublicKey: p256dh, authSecret: Buffer.alloc(8) }),
    /auth secret must be 16 bytes/,
  )
})
