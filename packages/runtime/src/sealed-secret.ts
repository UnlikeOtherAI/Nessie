import { decryptWithKey, deriveSecretKey, encryptWithKey } from './secret-crypto.js'

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
 * Packed form: `iv.authTag.ciphertext`, each hex, `.`-delimited.
 */
const PACK_SEPARATOR = '.'

export const sealSecret = (encryptionSecret: string, plaintext: string): string => {
  const key = deriveSecretKey(encryptionSecret)
  const { ciphertext, iv, authTag } = encryptWithKey(key, plaintext)
  return [iv, authTag, ciphertext].join(PACK_SEPARATOR)
}

export const openSecret = (encryptionSecret: string, packed: string): string => {
  const parts = packed.split(PACK_SEPARATOR)
  if (parts.length !== 3) {
    throw new Error('[sealed-secret] malformed sealed secret')
  }
  const [iv, authTag, ciphertext] = parts as [string, string, string]
  const key = deriveSecretKey(encryptionSecret)
  return decryptWithKey(key, { ciphertext, iv, authTag })
}
