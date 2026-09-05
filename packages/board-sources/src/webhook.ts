import { createHmac, timingSafeEqual } from 'node:crypto'

/**
 * Webhook intake shapes and the signature comparisons adapters share.
 *
 * The intake route does nothing but enqueue; verification happens in the worker
 * with the deployment secret, so a forged delivery costs one queued job and
 * never reaches a provider call. Same split the comms connector uses.
 */

export type WebhookRequest = {
  provider: string
  headers: Record<string, string>
  /** The raw body exactly as delivered — signatures are over bytes, not JSON. */
  rawBody: string
  /** The per-source callback token, for providers that do not sign. */
  token?: string
}

export type WebhookDelivery = {
  /** Provider-supplied delivery id, for idempotency. */
  deliveryId: string
  /** The adapter's canonical container key this delivery belongs to. */
  containerKey: string | null
  /** External ids to re-read, when the payload carries ids rather than items. */
  externalIds: string[]
}

export type WebhookRegistration = {
  externalId: string
  expiresAt: string | null
}

export type WebhookSecrets = {
  /** The deployment's app-level signing secret, where the provider has one. */
  signingSecret?: string
  /** SHA-256 of the per-source callback token, where the provider does not sign. */
  tokenHash?: string
}

/** Constant-time comparison that cannot leak length through an early return. */
export const secureEquals = (a: string, b: string): boolean => {
  const left = Buffer.from(a, 'utf8')
  const right = Buffer.from(b, 'utf8')
  if (left.length !== right.length) return false
  return timingSafeEqual(left, right)
}

export const hmacHex = (
  algorithm: 'sha1' | 'sha256',
  secret: string,
  payload: string,
): string => createHmac(algorithm, secret).update(payload).digest('hex')

export const hmacBase64 = (
  algorithm: 'sha1' | 'sha256',
  secret: string,
  payload: string,
): string => createHmac(algorithm, secret).update(payload).digest('base64')
