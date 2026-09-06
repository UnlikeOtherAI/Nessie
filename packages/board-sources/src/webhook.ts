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
  /**
   * Provider-supplied delivery id, for idempotency — **null** when this
   * provider gives none, which the intake route turns into a hash of the body
   * rather than inventing one. It used to fall back to `Date.now()`, which
   * reads like an id and dedupes nothing: a retry minted a fresh key and
   * became a second job.
   */
  deliveryId: string | null
  /** The adapter's canonical container key this delivery belongs to. */
  containerKey: string | null
  /** External ids to re-read, when the payload carries ids rather than items. */
  externalIds: string[]
}

export type WebhookRegistration = {
  externalId: string
  expiresAt: string | null
  /**
   * The secret this registration's deliveries are signed with, when the
   * provider has one and it is per-source. Linear mints its own and hands it
   * back once at creation; GitHub takes the one the caller offered. Either way
   * the caller persists it encrypted — a per-source secret is the whole point
   * of registering per source, because it means a deployment needs no app-level
   * webhook configured to get pushed changes.
   */
  signingSecret?: string
}

export type WebhookSecrets = {
  /**
   * The secret this source's deliveries are signed with: the one the
   * registration returned, falling back to the deployment's app-level secret
   * where the provider only has that.
   */
  signingSecret?: string
  /** SHA-256 of the per-source callback token, where the provider does not sign. */
  tokenHash?: string
  /**
   * The exact URL this source's webhook was registered at. Only Trello needs
   * it — it signs `body + callbackURL` rather than the body alone — and it is
   * rebuilt from the delivery's own token rather than stored, so it cannot
   * drift from the URL the provider is actually calling.
   */
  callbackUrl?: string
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
