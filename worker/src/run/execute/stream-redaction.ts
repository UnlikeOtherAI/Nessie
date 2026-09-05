import { detectSecrets, redactDetectedSecrets } from '@nessie/schemas'

/**
 * Holds back enough of a live token stream that a credential is never
 * broadcast before the scanner can see all of it.
 *
 * The finished message is redacted on its own path, but the SSE lane is a
 * separate broadcast that reaches every viewer as the model types. Scanning
 * each chunk alone does not work: a provider splits wherever it likes, so
 * `sk_live_` and the rest of the key routinely arrive as different chunks and
 * neither half matches on its own.
 *
 * So emission trails the stream. Text is released only up to the last
 * whitespace that is at least `HOLD_BACK` characters from the end, because a
 * credential contains no whitespace — anything before such a boundary is
 * complete, and anything after it may still be growing. `flush` releases the
 * remainder once the provider is done.
 */
const HOLD_BACK = 256

export const createStreamRedactor = () => {
  let pending = ''

  return {
    /** Text safe to broadcast now, redacted. Empty while everything is held. */
    push: (chunk: string): string => {
      pending += chunk
      if (pending.length <= HOLD_BACK) return ''
      const boundary = pending.lastIndexOf(' ', pending.length - HOLD_BACK)
      const newline = pending.lastIndexOf('\n', pending.length - HOLD_BACK)
      const releaseAt = Math.max(boundary, newline)
      if (releaseAt <= 0) return ''
      const release = pending.slice(0, releaseAt + 1)
      pending = pending.slice(releaseAt + 1)
      return redactDetectedSecrets(release)
    },

    /** Whatever is still held, redacted. Call once the stream has finished. */
    flush: (): string => {
      const remaining = pending
      pending = ''
      return remaining ? redactDetectedSecrets(remaining) : ''
    },

    /**
     * True once anything held looks like a credential — the caller can stop
     * the live lane entirely rather than stream around it.
     */
    holdsSecret: (): boolean => detectSecrets(pending).length > 0,
  }
}
