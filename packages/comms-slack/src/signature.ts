import crypto from 'node:crypto'

/** Slack rejects Events API deliveries older than five minutes (replay guard). */
export const SLACK_MAX_SKEW_SECONDS = 5 * 60

/** Thrown when an inbound webhook fails signature or freshness verification. */
export class SlackSignatureError extends Error {
  readonly reason: 'missing' | 'stale' | 'mismatch'

  constructor(reason: 'missing' | 'stale' | 'mismatch') {
    super(`[slack] webhook signature ${reason}`)
    this.name = 'SlackSignatureError'
    this.reason = reason
  }
}

export type SlackSignatureInput = {
  signingSecret: string
  /** `X-Slack-Signature` header (`v0=<hex>`). */
  signature?: string
  /** `X-Slack-Request-Timestamp` header (unix seconds). */
  timestamp?: string
  /** The exact raw request body bytes as a string. */
  rawBody: string
  /** Current time in ms (injectable for tests). */
  nowMs: number
}

/**
 * Verify a Slack Events API request per the `v0` scheme: the HMAC-SHA256 of
 * `v0:{timestamp}:{rawBody}` keyed by the signing secret, compared in constant
 * time, with deliveries outside {@link SLACK_MAX_SKEW_SECONDS} rejected as
 * stale. Throws {@link SlackSignatureError} on any failure; returns void on ok.
 */
export const verifySlackSignature = (input: SlackSignatureInput): void => {
  if (!input.signature || !input.timestamp) {
    throw new SlackSignatureError('missing')
  }

  const timestampSeconds = Number.parseInt(input.timestamp, 10)
  if (!Number.isFinite(timestampSeconds)) {
    throw new SlackSignatureError('missing')
  }
  const skewSeconds = Math.abs(input.nowMs / 1000 - timestampSeconds)
  if (skewSeconds > SLACK_MAX_SKEW_SECONDS) {
    throw new SlackSignatureError('stale')
  }

  const basestring = `v0:${input.timestamp}:${input.rawBody}`
  const expected = `v0=${crypto
    .createHmac('sha256', input.signingSecret)
    .update(basestring, 'utf8')
    .digest('hex')}`

  const provided = Buffer.from(input.signature, 'utf8')
  const computed = Buffer.from(expected, 'utf8')
  if (
    provided.length !== computed.length
    || !crypto.timingSafeEqual(provided, computed)
  ) {
    throw new SlackSignatureError('mismatch')
  }
}
