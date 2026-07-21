import crypto from 'node:crypto'

import {
  decryptWithKey,
  deriveSecretKey,
  encryptWithKey,
} from '@nessie/runtime'

/**
 * Credential-at-rest helpers for communications connections.
 *
 * These do NOT introduce a new cipher: they reuse the exact shared
 * `@nessie/runtime` AES-256-GCM secret-crypto primitives (`deriveSecretKey`,
 * `encryptWithKey`, `decryptWithKey`) that the MCP OAuth secret store and web
 * push dispatch already use. The only thing added here is a self-describing
 * on-the-wire packing so a whole token fits one `TEXT` column
 * (`CommsConnectionCredential.accessTokenCiphertext` /
 * `refreshTokenCiphertext`) instead of three, keeping the schema exactly as
 * specified while still carrying the GCM iv + auth tag.
 *
 * Packed form: `iv.authTag.ciphertext` (each hex, `.`-delimited).
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
    throw new Error('[comms-credential] malformed sealed secret')
  }
  const [iv, authTag, ciphertext] = parts as [string, string, string]
  const key = deriveSecretKey(encryptionSecret)
  return decryptWithKey(key, { ciphertext, iv, authTag })
}

/**
 * A stable hash of a granted-scope set, order-independent. Persisted as
 * `CommsConnectionCredential.scopeHash` so a re-auth can detect that the scope
 * grant changed without decrypting the token bundle.
 */
export const computeScopeHash = (scopes: readonly string[]): string => {
  const normalized = [...new Set(scopes.map((scope) => scope.trim()))]
    .filter((scope) => scope.length > 0)
    .sort()
    .join(' ')
  return crypto.createHash('sha256').update(normalized, 'utf8').digest('hex')
}
