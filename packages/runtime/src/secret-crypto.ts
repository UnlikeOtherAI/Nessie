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

/**
 * The deployment's at-rest encryption roots. These are intentionally distinct
 * from the auth signing root: rotating a session-signing key must never make
 * persisted connector credentials, refresh credentials, or push credentials
 * unreadable.
 */
export type EncryptionKeyRing = {
  activeVersion: string
  keys: Readonly<Record<string, string>>
  /** The former unversioned NESSIE_AUTH_SECRET, retained only during migration. */
  legacyKey?: string
}

export type EncryptionKeyRingInput = EncryptionKeyRing | string

/**
 * Compatibility only for isolated callers/tests while they are moved to the
 * deployment-owned ring. Server and worker startup must pass a real ring.
 */
export const toEncryptionKeyRing = (
  input: EncryptionKeyRingInput,
): EncryptionKeyRing => typeof input === 'string'
  ? {
      activeVersion: 'legacy-inline',
      keys: { 'legacy-inline': input },
      legacyKey: input,
    }
  : input

export type OpenedSecret = {
  plaintext: string
  keyVersion: string | null
  /** True when a write should replace this legacy or retired-key ciphertext. */
  needsReencryption: boolean
}

const ENVELOPE_MARKER = 'nsk1'

const keyForPurpose = (
  root: string,
  purpose: string,
  version: string,
): Buffer => Buffer.from(crypto.hkdfSync(
  'sha256',
  Buffer.from(root, 'utf8'),
  Buffer.alloc(0),
  Buffer.from(`nessie:at-rest:${purpose}:${version}`, 'utf8'),
  32,
))

const assertPurpose = (purpose: string): void => {
  if (!/^[a-z0-9][a-z0-9._-]{0,127}$/i.test(purpose)) {
    throw new Error('[secret-crypto] encryption purpose must be a stable identifier.')
  }
}

const envelopeParts = (
  ciphertext: string,
): { version: string; purpose: string; ciphertext: string } | null => {
  const pieces = ciphertext.split('.')
  if (pieces.length !== 4 || pieces[0] !== ENVELOPE_MARKER) return null
  const [, version, encodedPurpose, encrypted] = pieces
  if (!version || !encodedPurpose || !encrypted || !/^[A-Za-z0-9_-]+$/.test(version)) {
    throw new Error('[secret-crypto] malformed encrypted secret envelope.')
  }
  let purpose: string
  try {
    purpose = Buffer.from(encodedPurpose, 'base64url').toString('utf8')
  } catch {
    throw new Error('[secret-crypto] malformed encrypted secret purpose.')
  }
  assertPurpose(purpose)
  return { version, purpose, ciphertext: encrypted }
}

const encryptWithAad = (
  key: Buffer,
  plaintext: string,
  aad: Buffer,
): EncryptedParts => {
  const iv = crypto.randomBytes(IV_BYTES)
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv)
  cipher.setAAD(aad)
  const ciphertext = cipher.update(plaintext, 'utf8', 'hex') + cipher.final('hex')
  return {
    ciphertext,
    iv: iv.toString('hex'),
    authTag: cipher.getAuthTag().toString('hex'),
  }
}

const decryptWithAad = (
  key: Buffer,
  parts: EncryptedParts,
  aad: Buffer,
): string => {
  const decipher = crypto.createDecipheriv(
    ALGORITHM,
    key,
    Buffer.from(parts.iv, 'hex'),
  )
  decipher.setAAD(aad)
  decipher.setAuthTag(Buffer.from(parts.authTag, 'hex'))
  return decipher.update(parts.ciphertext, 'hex', 'utf8') + decipher.final('utf8')
}

/**
 * Encrypt a persisted secret under the active, purpose-specific key. The
 * version and purpose travel in the ciphertext envelope so every read can
 * select the correct retained key without trusting a separate database column.
 */
export const encryptWithKeyRing = (
  ring: EncryptionKeyRing,
  purpose: string,
  plaintext: string,
): EncryptedParts => {
  assertPurpose(purpose)
  const root = ring.keys[ring.activeVersion]
  if (!root) {
    throw new Error(`[secret-crypto] active encryption key '${ring.activeVersion}' is unavailable.`)
  }
  const aad = Buffer.from(`nessie:at-rest:${purpose}:${ring.activeVersion}`, 'utf8')
  const encrypted = encryptWithAad(
    keyForPurpose(root, purpose, ring.activeVersion),
    plaintext,
    aad,
  )
  return {
    ...encrypted,
    ciphertext: [
      ENVELOPE_MARKER,
      ring.activeVersion,
      Buffer.from(purpose, 'utf8').toString('base64url'),
      encrypted.ciphertext,
    ].join('.'),
  }
}

/**
 * Read both new envelopes and legacy auth-secret ciphertext. A caller that
 * persists the plaintext can use `needsReencryption` to replace old material
 * under the active key before the legacy root is retired.
 */
export const decryptWithKeyRing = (
  ring: EncryptionKeyRing,
  purpose: string,
  parts: EncryptedParts,
): OpenedSecret => {
  assertPurpose(purpose)
  const envelope = envelopeParts(parts.ciphertext)
  if (!envelope) {
    const legacyRoot = ring.legacyKey
    if (!legacyRoot) {
      throw new Error('[secret-crypto] legacy ciphertext requires a retained legacy encryption root.')
    }
    return {
      plaintext: decryptWithKey(deriveSecretKey(legacyRoot), parts),
      keyVersion: null,
      needsReencryption: true,
    }
  }
  if (envelope.purpose !== purpose) {
    throw new Error('[secret-crypto] ciphertext purpose does not match this store.')
  }
  const root = ring.keys[envelope.version]
  if (!root) {
    throw new Error(`[secret-crypto] encryption key '${envelope.version}' is unavailable.`)
  }
  const aad = Buffer.from(`nessie:at-rest:${purpose}:${envelope.version}`, 'utf8')
  return {
    plaintext: decryptWithAad(
      keyForPurpose(root, purpose, envelope.version),
      { ...parts, ciphertext: envelope.ciphertext },
      aad,
    ),
    keyVersion: envelope.version,
    needsReencryption: envelope.version !== ring.activeVersion,
  }
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
