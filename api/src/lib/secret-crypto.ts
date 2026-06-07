import crypto from 'node:crypto'

/**
 * AES-256-GCM primitives shared by the encrypted secret stores.
 *
 * Extracted from `services/mcp-oauth-secret-store.ts` so the push-credentials
 * store can encrypt raw secret bytes at rest with the exact same scheme (a key
 * derived from the deployment's auth secret) instead of duplicating crypto.
 * Both stores persist to the `mcp_oauth_secret` table; the ref prefix
 * distinguishes their entries.
 */

const ALGORITHM = 'aes-256-gcm'
const IV_BYTES = 12

export type EncryptedParts = {
  ciphertext: string
  iv: string
  authTag: string
}

export const deriveSecretKey = (secret: string): Buffer => {
  if (!secret) {
    throw new Error(
      '[secret-crypto] requires a non-empty encryption secret '
        + '(config.auth.secret / NESSIE_AUTH_SECRET).',
    )
  }
  return crypto.createHash('sha256').update(secret, 'utf8').digest()
}

export const encryptWithKey = (key: Buffer, plaintext: string): EncryptedParts => {
  const iv = crypto.randomBytes(IV_BYTES)
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv)
  const ciphertext = cipher.update(plaintext, 'utf8', 'hex') + cipher.final('hex')
  return {
    ciphertext,
    iv: iv.toString('hex'),
    authTag: cipher.getAuthTag().toString('hex'),
  }
}

export const decryptWithKey = (key: Buffer, parts: EncryptedParts): string => {
  const decipher = crypto.createDecipheriv(
    ALGORITHM,
    key,
    Buffer.from(parts.iv, 'hex'),
  )
  decipher.setAuthTag(Buffer.from(parts.authTag, 'hex'))
  return decipher.update(parts.ciphertext, 'hex', 'utf8') + decipher.final('utf8')
}
