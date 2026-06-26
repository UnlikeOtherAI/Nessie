/**
 * Web Push payload encryption — RFC 8291 (aes128gcm) over RFC 8188 content
 * coding. Plain `node:crypto`, no third-party library.
 *
 * Given the subscriber's public key (`p256dh`) and `auth` secret, the message
 * is encrypted so only that subscriber's browser can read it. The push service
 * relays the opaque ciphertext blind.
 *
 * Wire layout of the returned body (RFC 8188 §2.1):
 *
 *   salt(16) | rs(4, big-endian) | idlen(1)=65 | as_public(65) | ciphertext+tag
 *
 * Key schedule (RFC 8291 §3.4):
 *
 *   ecdh        = ECDH(as_private, ua_public)
 *   ikm         = HKDF(salt=auth, ikm=ecdh, info="WebPush: info\0"||ua||as, 32)
 *   cek         = HKDF(salt,       ikm,      "Content-Encoding: aes128gcm\0", 16)
 *   nonce       = HKDF(salt,       ikm,      "Content-Encoding: nonce\0",     12)
 */
import { createECDH, hkdfSync, createCipheriv, randomBytes } from 'node:crypto'

/** Inputs needed to encrypt a single Web Push message for one subscription. */
export interface WebPushEncryptInput {
  /** UTF-8 (or arbitrary) plaintext bytes to deliver. */
  payload: Buffer
  /** Raw 65-byte uncompressed P-256 public key from the subscription (`p256dh`). */
  uaPublicKey: Buffer
  /** Raw 16-byte subscription `auth` secret. */
  authSecret: Buffer
}

const RECORD_SIZE = 4096
const KEY_LABEL = Buffer.concat([Buffer.from('WebPush: info', 'ascii'), Buffer.from([0])])
const CEK_INFO = Buffer.concat([
  Buffer.from('Content-Encoding: aes128gcm', 'ascii'),
  Buffer.from([0]),
])
const NONCE_INFO = Buffer.concat([
  Buffer.from('Content-Encoding: nonce', 'ascii'),
  Buffer.from([0]),
])

const hkdf = (ikm: Buffer, salt: Buffer, info: Buffer, length: number): Buffer =>
  Buffer.from(hkdfSync('sha256', ikm, salt, info, length))

/**
 * Encrypt `payload` for a Web Push subscription. The ephemeral application-server
 * key pair and the content-encoding salt are generated fresh per call (random),
 * so two calls with identical inputs produce distinct ciphertext — as required.
 */
export const encryptWebPushPayload = (input: WebPushEncryptInput): Buffer => {
  if (input.uaPublicKey.length !== 65 || input.uaPublicKey[0] !== 0x04) {
    throw new Error(
      `subscription p256dh must be a 65-byte uncompressed P-256 point, got ${input.uaPublicKey.length} bytes`,
    )
  }
  if (input.authSecret.length !== 16) {
    throw new Error(`subscription auth secret must be 16 bytes, got ${input.authSecret.length} bytes`)
  }

  // Ephemeral application-server ECDH key pair + shared secret with the UA.
  const localEcdh = createECDH('prime256v1')
  const asPublic = localEcdh.generateKeys()
  const sharedSecret = localEcdh.computeSecret(input.uaPublicKey)

  // Stage 1 (RFC 8291): combine the ECDH secret with the auth secret.
  const keyInfo = Buffer.concat([KEY_LABEL, input.uaPublicKey, asPublic])
  const ikm = hkdf(sharedSecret, input.authSecret, keyInfo, 32)

  // Stage 2 (RFC 8188): derive the content-encryption key and nonce from a salt.
  const salt = randomBytes(16)
  const cek = hkdf(ikm, salt, CEK_INFO, 16)
  const nonce = hkdf(ikm, salt, NONCE_INFO, 12)

  // Single record: plaintext followed by the 0x02 last-record delimiter.
  const record = Buffer.concat([input.payload, Buffer.from([0x02])])
  // A single aes128gcm record (incl. the 16-byte GCM tag) must fit within `rs`,
  // or the UA mis-frames it and decryption fails. Push services cap the body
  // near this size too, so reject oversize payloads loudly instead of shipping
  // an undeliverable blob.
  if (record.length + 16 > RECORD_SIZE) {
    throw new Error(
      `Web Push payload too large: ${input.payload.length} bytes exceeds the single-record limit`,
    )
  }
  const cipher = createCipheriv('aes-128-gcm', cek, nonce)
  const ciphertext = Buffer.concat([cipher.update(record), cipher.final(), cipher.getAuthTag()])

  const header = Buffer.alloc(16 + 4 + 1)
  salt.copy(header, 0)
  header.writeUInt32BE(RECORD_SIZE, 16)
  header.writeUInt8(asPublic.length, 20)

  return Buffer.concat([header, asPublic, ciphertext])
}
