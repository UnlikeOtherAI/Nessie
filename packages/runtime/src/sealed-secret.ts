import {
  decryptWithKeyRing,
  encryptWithKeyRing,
  toEncryptionKeyRing,
  type EncryptionKeyRingInput,
} from './secret-crypto.js'

/**
 * Packing a secret into one column.
 *
 * This introduces no cipher of its own: it is the shared AES-256-GCM
 * `secret-crypto` primitives plus a self-describing packing, so a whole token
 * fits a single `TEXT` column instead of three while still carrying the GCM iv
 * and auth tag.
 *
 * It began in `@nessie/comms-connect` for the communications credential rows.
 * It lives here now because board sources need the same packing for their own
 * credential rows, and the alternative — a second connector package importing
 * a first one for a cryptographic helper — would have made the comms package a
 * dependency of everything that stores a token.
 *
 * Packed form: `iv.authTag.ciphertext`, each hex, `.`-delimited. The
 * ciphertext is a versioned purpose-bound envelope, while older packed values
 * remain readable through a retained legacy root.
 */
const PACK_SEPARATOR = '.'

export const sealSecret = (
  encryption: EncryptionKeyRingInput,
  plaintext: string,
  purpose = 'sealed.secret',
): string => {
  const { ciphertext, iv, authTag } = encryptWithKeyRing(
    toEncryptionKeyRing(encryption),
    purpose,
    plaintext,
  )
  return [iv, authTag, ciphertext].join(PACK_SEPARATOR)
}

export const openSecret = (
  encryption: EncryptionKeyRingInput,
  packed: string,
  purpose = 'sealed.secret',
): string => {
  const parts = packed.split(PACK_SEPARATOR)
  if (parts.length !== 3) {
    throw new Error('[sealed-secret] malformed sealed secret')
  }
  const [iv, authTag, ciphertext] = parts as [string, string, string]
  return decryptWithKeyRing(
    toEncryptionKeyRing(encryption),
    purpose,
    { ciphertext, iv, authTag },
  ).plaintext
}
