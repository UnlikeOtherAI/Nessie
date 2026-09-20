import {
  AT_REST_SECRET_PURPOSE,
  decryptWithKeyRing,
  encryptWithKeyRing,
  toEncryptionKeyRing,
  type EncryptionKeyRingInput,
} from './secret-crypto.js'

type PackedCiphertext = {
  authTag: string
  ciphertext: string
  iv: string
}

/**
 * The database stores opaque bytes, never a JSON request/result directly.
 * Keeping the packing here ensures API relay and worker recovery cannot drift
 * on purpose binding or accidentally write a plaintext fallback.
 */
export const sealLocalInferenceAttempt = (
  ring: EncryptionKeyRingInput,
  value: unknown,
): Buffer => Buffer.from(JSON.stringify(encryptWithKeyRing(
  toEncryptionKeyRing(ring),
  AT_REST_SECRET_PURPOSE.localInferenceAttempt,
  JSON.stringify(value),
)), 'utf8')

export const openLocalInferenceAttempt = <Value>(
  ring: EncryptionKeyRingInput,
  ciphertext: Uint8Array<ArrayBufferLike>,
): Value => {
  const packed = JSON.parse(Buffer.from(ciphertext).toString('utf8')) as PackedCiphertext
  return JSON.parse(decryptWithKeyRing(
    toEncryptionKeyRing(ring),
    AT_REST_SECRET_PURPOSE.localInferenceAttempt,
    packed,
  ).plaintext) as Value
}
