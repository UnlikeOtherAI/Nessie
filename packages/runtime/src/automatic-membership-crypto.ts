import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'

const key = (secret: string): Buffer => createHash('sha256').update(secret).digest()

/** Encrypts DNS proof material; callers must never persist the plaintext. */
export const encryptAutomaticMembershipChallenge = (value: string, secret: string): string => {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key(secret), iv)
  return [iv.toString('base64url'), cipher.update(value, 'utf8', 'base64url') + cipher.final('base64url'), cipher.getAuthTag().toString('base64url')].join('.')
}

export const decryptAutomaticMembershipChallenge = (value: string, secret: string): string => {
  const [ivRaw, ciphertext, tagRaw] = value.split('.')
  if (!ivRaw || !ciphertext || !tagRaw) throw new Error('Invalid encrypted automatic-membership challenge')
  const decipher = createDecipheriv('aes-256-gcm', key(secret), Buffer.from(ivRaw, 'base64url'))
  decipher.setAuthTag(Buffer.from(tagRaw, 'base64url'))
  return decipher.update(ciphertext, 'base64url', 'utf8') + decipher.final('utf8')
}

export const createAutomaticMembershipChallenge = (): string =>
  `nessie-auto-access=${randomBytes(32).toString('base64url')}`
