import { createVerify } from 'node:crypto'

/**
 * SNS message verification for the public inbound route.
 *
 * Three independent checks, all required:
 *
 *  1. **The certificate is Amazon's.** `SigningCertURL` is host-pinned to
 *     `sns.<region>.amazonaws.com` (and the China/GovCloud partitions) over
 *     HTTPS, fetched through the caller's pinned fetch, and size-capped.
 *  2. **The signature covers the canonical string.** Built per the SNS spec
 *     from the exact field set for the message type — not from whatever fields
 *     happen to be present, which is how a crafted payload smuggles content
 *     past a signature that never covered it.
 *  3. **The topic is ours.** `TopicArn` must equal the configured topic. Any
 *     AWS customer can obtain a genuinely Amazon-signed message from their own
 *     topic, so signature validity alone proves nothing about who sent it.
 *
 * `SubscriptionConfirmation` is deliberately **not** handled here. The API
 * subscribes itself to the configured topic at startup, so a confirmation
 * arriving at the public route is either unnecessary or someone else's topic
 * probing for a live endpoint; the route rejects it outright.
 */

export type SnsMessageType = 'Notification' | 'SubscriptionConfirmation' | 'UnsubscribeConfirmation'

export type SnsEnvelope = {
  Type: SnsMessageType
  MessageId: string
  TopicArn?: string
  Subject?: string
  Message: string
  Timestamp: string
  SignatureVersion: string
  Signature: string
  SigningCertURL?: string
  SigningCertUrl?: string
  SubscribeURL?: string
  Token?: string
}

export type SnsVerificationFailure =
  | 'malformed'
  | 'unsupported_type'
  | 'unsupported_signature_version'
  | 'topic_mismatch'
  | 'certificate_url_rejected'
  | 'certificate_fetch_failed'
  | 'signature_invalid'
  | 'stale_timestamp'

export type SnsVerificationResult =
  | { ok: true; envelope: SnsEnvelope }
  | { ok: false; reason: SnsVerificationFailure }

/** Fetch shaped like the runtime's pinned fetch; the caller supplies it. */
export type CertificateFetch = (url: string) => Promise<{ ok: boolean; text: () => Promise<string> }>

const CERT_HOST = /^sns\.[a-z0-9-]+\.amazonaws\.com(\.cn)?$/
const MAX_CERT_BYTES = 32 * 1024
/** SNS replays for up to an hour; anything older is a replayed capture. */
const MAX_TIMESTAMP_SKEW_MS = 60 * 60 * 1000

const SIGNABLE_FIELDS: Record<SnsMessageType, string[]> = {
  // Order is part of the spec, not a preference.
  Notification: ['Message', 'MessageId', 'Subject', 'Timestamp', 'TopicArn', 'Type'],
  SubscriptionConfirmation: [
    'Message', 'MessageId', 'SubscribeURL', 'Timestamp', 'Token', 'TopicArn', 'Type',
  ],
  UnsubscribeConfirmation: [
    'Message', 'MessageId', 'SubscribeURL', 'Timestamp', 'Token', 'TopicArn', 'Type',
  ],
}

export const isAllowedSigningCertUrl = (raw: string | undefined): boolean => {
  if (!raw) return false
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return false
  }
  if (url.protocol !== 'https:') return false
  if (!CERT_HOST.test(url.hostname)) return false
  return url.pathname.endsWith('.pem')
}

const buildCanonicalString = (envelope: SnsEnvelope): string | null => {
  const fields = SIGNABLE_FIELDS[envelope.Type]
  if (!fields) return null
  const parts: string[] = []
  for (const field of fields) {
    const value = (envelope as unknown as Record<string, unknown>)[field]
    // An absent optional field (Subject) is skipped; an absent required one
    // makes the message unverifiable rather than verifiable-with-less.
    if (value === undefined || value === null) {
      if (field === 'Subject') continue
      return null
    }
    parts.push(field, String(value))
  }
  return `${parts.join('\n')}\n`
}

export const parseSnsEnvelope = (raw: string): SnsEnvelope | null => {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const candidate = parsed as Partial<SnsEnvelope>
  if (
    typeof candidate.Type !== 'string'
    || typeof candidate.MessageId !== 'string'
    || typeof candidate.Message !== 'string'
    || typeof candidate.Timestamp !== 'string'
    || typeof candidate.Signature !== 'string'
  ) {
    return null
  }
  return candidate as SnsEnvelope
}

export const verifySnsMessage = async (input: {
  rawBody: string
  expectedTopicArn: string
  fetchCertificate: CertificateFetch
  now?: Date
  certificateCache?: Map<string, string>
}): Promise<SnsVerificationResult> => {
  const envelope = parseSnsEnvelope(input.rawBody)
  if (!envelope) return { ok: false, reason: 'malformed' }

  // The API self-subscribes; a confirmation on the public route is never ours
  // to act on, and acting on one is a live-endpoint oracle for any stranger.
  if (envelope.Type !== 'Notification') {
    return { ok: false, reason: 'unsupported_type' }
  }
  if (envelope.SignatureVersion !== '1' && envelope.SignatureVersion !== '2') {
    return { ok: false, reason: 'unsupported_signature_version' }
  }
  if (envelope.TopicArn !== input.expectedTopicArn) {
    return { ok: false, reason: 'topic_mismatch' }
  }

  const timestamp = Date.parse(envelope.Timestamp)
  const now = (input.now ?? new Date()).getTime()
  if (!Number.isFinite(timestamp) || Math.abs(now - timestamp) > MAX_TIMESTAMP_SKEW_MS) {
    return { ok: false, reason: 'stale_timestamp' }
  }

  const certUrl = envelope.SigningCertURL ?? envelope.SigningCertUrl
  if (!isAllowedSigningCertUrl(certUrl)) {
    return { ok: false, reason: 'certificate_url_rejected' }
  }

  let pem = input.certificateCache?.get(certUrl as string)
  if (!pem) {
    try {
      const response = await input.fetchCertificate(certUrl as string)
      if (!response.ok) return { ok: false, reason: 'certificate_fetch_failed' }
      const body = await response.text()
      if (body.length > MAX_CERT_BYTES) return { ok: false, reason: 'certificate_fetch_failed' }
      pem = body
      input.certificateCache?.set(certUrl as string, body)
    } catch {
      return { ok: false, reason: 'certificate_fetch_failed' }
    }
  }

  const canonical = buildCanonicalString(envelope)
  if (!canonical) return { ok: false, reason: 'malformed' }

  const algorithm = envelope.SignatureVersion === '2' ? 'RSA-SHA256' : 'RSA-SHA1'
  try {
    const verifier = createVerify(algorithm)
    verifier.update(canonical, 'utf8')
    if (!verifier.verify(pem, envelope.Signature, 'base64')) {
      return { ok: false, reason: 'signature_invalid' }
    }
  } catch {
    return { ok: false, reason: 'signature_invalid' }
  }

  return { envelope, ok: true }
}
