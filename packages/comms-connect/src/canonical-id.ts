import type { CommsProviderId } from './provider.js'
import { isCommsProviderId } from './provider.js'

/**
 * The deterministic identity of a single imported message. Every ingestion path
 * derives the same key from the same message, so re-imports and webhook/backfill
 * overlap collapse to one logical event (with edits carried as separate versions).
 *
 * Shape: `provider:tenantId:conversationId:messageId`, e.g.
 * `slack:T123:C456:1721550000.000100`.
 *
 * Each part must be non-empty and must not contain the `:` separator, so the
 * key round-trips unambiguously. Providers whose native ids contain `:` must
 * encode them before building the key.
 */
export const CANONICAL_ID_SEPARATOR = ':'

const assertPart = (label: string, value: string): void => {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`[canonical-id] ${label} must be a non-empty string`)
  }
  if (value.includes(CANONICAL_ID_SEPARATOR)) {
    throw new Error(
      `[canonical-id] ${label} must not contain "${CANONICAL_ID_SEPARATOR}" `
        + `(got "${value}")`,
    )
  }
}

export const buildCanonicalMessageId = (
  provider: CommsProviderId,
  tenantId: string,
  conversationId: string,
  messageId: string,
): string => {
  if (!isCommsProviderId(provider)) {
    throw new Error(`[canonical-id] unknown provider "${String(provider)}"`)
  }
  assertPart('tenantId', tenantId)
  assertPart('conversationId', conversationId)
  assertPart('messageId', messageId)
  return [provider, tenantId, conversationId, messageId].join(
    CANONICAL_ID_SEPARATOR,
  )
}

export type ParsedCanonicalMessageId = {
  provider: CommsProviderId
  tenantId: string
  conversationId: string
  messageId: string
}

/**
 * Inverse of {@link buildCanonicalMessageId}. Throws on any key that was not
 * produced by this module (wrong arity or unknown provider).
 */
export const parseCanonicalMessageId = (
  canonicalMessageId: string,
): ParsedCanonicalMessageId => {
  const parts = canonicalMessageId.split(CANONICAL_ID_SEPARATOR)
  if (parts.length !== 4) {
    throw new Error(
      `[canonical-id] expected 4 parts, got ${parts.length} `
        + `("${canonicalMessageId}")`,
    )
  }
  const [provider, tenantId, conversationId, messageId] = parts as [
    string,
    string,
    string,
    string,
  ]
  if (!isCommsProviderId(provider)) {
    throw new Error(`[canonical-id] unknown provider "${provider}"`)
  }
  return { provider, tenantId, conversationId, messageId }
}
