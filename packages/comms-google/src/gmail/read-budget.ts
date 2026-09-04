/**
 * Provider JSON and base64 payloads are untrusted mailbox data. Keep the
 * limits here, beside Gmail's readers, so a new read cannot accidentally make
 * the aggregate request or decoded-body budget optional.
 */
export const GMAIL_MAX_READ_RESPONSE_BYTES = 512 * 1024
export const GMAIL_MAX_READ_AGGREGATE_BYTES = 2 * 1024 * 1024
export const GMAIL_MAX_DECODED_BODY_BYTES = 256 * 1024
/** Metadata calls run concurrently, so each gets a smaller individual cap. */
export const GMAIL_MAX_METADATA_RESPONSE_BYTES = 64 * 1024

export class GmailReadLimitError extends Error {
  constructor(kind: 'http' | 'decoded') {
    super(`[comms-google] Gmail ${kind} read budget exceeded`)
    this.name = 'GmailReadLimitError'
  }
}

export class GmailReadBudget {
  #httpBytes = 0
  #decodedBytes = 0

  addHttp(bytes: number): void {
    this.#httpBytes += bytes
    if (this.#httpBytes > GMAIL_MAX_READ_AGGREGATE_BYTES) {
      throw new GmailReadLimitError('http')
    }
  }

  decode(value: unknown): string {
    if (typeof value !== 'string') return ''
    const decoded = Buffer.from(value, 'base64url')
    this.#decodedBytes += decoded.byteLength
    if (this.#decodedBytes > GMAIL_MAX_DECODED_BODY_BYTES) {
      throw new GmailReadLimitError('decoded')
    }
    return decoded.toString('utf8')
  }
}
