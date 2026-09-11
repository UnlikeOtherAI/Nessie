import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'

const IV_BYTES = 12
const AUTH_TAG_BYTES = 16

export class OpaqueCursorError extends Error {}

type CursorCodec = { keyPurpose: string; prefix: string; secret: string }

const cursorKey = ({ keyPurpose, secret }: CursorCodec): Buffer =>
  createHash('sha256').update(keyPurpose).update(secret).digest()

/** Encrypt an opaque pagination continuation with a purpose-specific key. */
export const sealOpaqueCursor = (codec: CursorCodec, payload: unknown): string => {
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv('aes-256-gcm', cursorKey(codec), iv)
  const encrypted = Buffer.concat([
    cipher.update(JSON.stringify(payload), 'utf8'),
    cipher.final(),
  ])
  return `${codec.prefix}${Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64url')}`
}

/** Open an opaque continuation or refuse it without revealing its contents. */
export const openOpaqueCursor = (codec: CursorCodec, token: string): unknown => {
  if (!token.startsWith(codec.prefix)) throw new OpaqueCursorError('Invalid cursor')
  try {
    const encrypted = Buffer.from(token.slice(codec.prefix.length), 'base64url')
    if (encrypted.length <= IV_BYTES + AUTH_TAG_BYTES) throw new OpaqueCursorError('Invalid cursor')
    const decipher = createDecipheriv('aes-256-gcm', cursorKey(codec), encrypted.subarray(0, IV_BYTES))
    decipher.setAuthTag(encrypted.subarray(IV_BYTES, IV_BYTES + AUTH_TAG_BYTES))
    return JSON.parse(Buffer.concat([
      decipher.update(encrypted.subarray(IV_BYTES + AUTH_TAG_BYTES)),
      decipher.final(),
    ]).toString('utf8'))
  } catch (error) {
    if (error instanceof OpaqueCursorError) throw error
    throw new OpaqueCursorError('Invalid cursor')
  }
}
