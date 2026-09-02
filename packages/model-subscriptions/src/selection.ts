import { findSubscriptionAdapter } from './adapters.js'
import type { SubscriptionProviderKey } from './types.js'

/**
 * An agent's `provider` column carries this prefix when it runs on someone's
 * personal subscription.
 *
 * The `/` is load-bearing: it is illegal in a Ledger service id
 * (`resolveLedgerServiceBaseUrl` throws on it), so a subscription selection
 * that ever escapes the subscription branch fails loudly instead of being
 * dispatched to Ledger as a bogus service. Routing still keys off
 * `Agent.modelSubscriptionId`, never off this string.
 */
export const SUBSCRIPTION_PROVIDER_PREFIX = 'subscription/'

export const subscriptionProviderKeyToColumn = (key: SubscriptionProviderKey): string =>
  `${SUBSCRIPTION_PROVIDER_PREFIX}${key}`

/** Null for every Ledger provider string, so callers can branch on one call. */
export const parseSubscriptionProviderColumn = (
  provider: string | null | undefined,
): SubscriptionProviderKey | null => {
  const value = provider?.trim()
  if (!value || !value.startsWith(SUBSCRIPTION_PROVIDER_PREFIX)) return null
  const key = value.slice(SUBSCRIPTION_PROVIDER_PREFIX.length)
  return findSubscriptionAdapter(key)?.key ?? null
}

export const isSubscriptionProviderColumn = (
  provider: string | null | undefined,
): boolean => parseSubscriptionProviderColumn(provider) !== null

/**
 * True for any value that merely *looks* like a subscription selection, even
 * one naming an adapter this deployment does not have.
 *
 * Read paths use this rather than `isSubscriptionProviderColumn` so a row
 * written by a newer replica — or naming a retired adapter — is refused rather
 * than falling through to the organization's Ledger route and quietly moving
 * the spend.
 */
export const looksLikeSubscriptionProviderColumn = (
  provider: string | null | undefined,
): boolean => provider?.trim().startsWith(SUBSCRIPTION_PROVIDER_PREFIX) === true
