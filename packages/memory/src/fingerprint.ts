import { createHash } from 'node:crypto'

/**
 * SHA-256 fingerprint for dedup.
 * Normalizes: lowercase, trim, collapse whitespace.
 */
export const computeFingerprint = (content: string): string => {
  const normalized = content.toLowerCase().trim().replace(/\s+/g, ' ')
  return createHash('sha256').update(normalized).digest('hex')
}
