import crypto from 'node:crypto'

/**
 * AES-256-GCM primitives shared by the encrypted secret stores.
 *
 * Lives in `@nessie/runtime` so both the api's secret stores
 * (`mcp-oauth-secret-store`, `push-secret-store`) and the worker's push
 * dispatch can encrypt/decrypt raw secret bytes at rest with the exact same
 * scheme (a key derived from the deployment's auth secret) instead of
 * duplicating crypto. Secrets persist to the `mcp_oauth_secret` table; the ref
 * prefix distinguishes their entries.
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

/**
 * Verify an HMAC-SHA256 signature over a payload, in constant time.
 *
 * The one verifier. Four sites each rolled their own — the trigger webhook
 * intake, the executor-daemon challenge, the product webhook receiver, and the
 * refresh-token successor chain — and they had already drifted on comparison
 * encoding (hex-decoded buffers vs raw digest bytes vs base64url text) and on
 * whether a `sha256=` prefix was accepted, with only one applying domain
 * separation (2026-09-05 review, F5-2). A timing fix applied to one of four
 * copies is not a fix.
 *
 * `encoding` is the wire encoding of the signature, and the comparison happens
 * on the encoded text so that a signature is accepted only in the exact form
 * the signer produced (hex is matched case-insensitively, since hex case
 * carries no meaning). `domain` is an optional purpose label mixed into the
 * MAC input as `<domain>\0` — the domain-separation convention
 * `services/refresh-token-crypto.ts` already models, so a MAC minted for one
 * purpose can never verify for another. Callers verifying an existing wire
 * format must keep passing the domain they signed with (for the three intake
 * surfaces above, none).
 */
export const verifyHmacSignature = (input: {
  domain?: string
  encoding: 'base64url' | 'hex'
  payload: Buffer | string
  prefix?: string
  secret: string
  signature: string | undefined
}): boolean => {
  if (!input.secret || !input.signature) return false

  const trimmed = input.signature.trim()
  const prefix = input.prefix
  const withoutPrefix = prefix && trimmed.toLowerCase().startsWith(prefix.toLowerCase())
    ? trimmed.slice(prefix.length)
    : trimmed
  if (withoutPrefix.length === 0) return false

  const hmac = crypto.createHmac('sha256', input.secret)
  if (input.domain) hmac.update(`${input.domain}\0`)
  hmac.update(input.payload)
  const expected = hmac.digest(input.encoding)

  const provided = input.encoding === 'hex' ? withoutPrefix.toLowerCase() : withoutPrefix
  const providedBytes = Buffer.from(provided, 'utf8')
  const expectedBytes = Buffer.from(expected, 'utf8')
  if (providedBytes.length !== expectedBytes.length) return false
  return crypto.timingSafeEqual(providedBytes, expectedBytes)
}
