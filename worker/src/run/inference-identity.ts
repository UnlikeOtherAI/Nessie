import {
  isLedgerEndpoint,
  type LedgerAttribution,
  type LedgerIdentityService,
} from '@nessie/runtime'

import type { ResolvedProviderConfig } from './inference-provider.js'

export type ProviderRequestHeadersResolver = (
  providerConfig: ResolvedProviderConfig,
) => Promise<Record<string, string> | undefined>

/**
 * Decide identity signing from the effective provider URL, after organization
 * routing has been resolved. Checking only the deployment-wide URL misses a
 * provider record that routes through Ledger.
 *
 * A signing deployment signs every Ledger route reached this way, including one
 * an organization provider record introduced, and still fails closed when the
 * originating user has no linked UOA identity. Only a deployment that
 * configured no signer at all dispatches on its Ledger API key alone; the
 * unsigned path can therefore never be reached by an organization, a user, or a
 * request shape, only by process env at startup.
 */
export const createProviderRequestHeadersResolver = (input: {
  attribution: LedgerAttribution
  ledgerIdentity?: LedgerIdentityService | null
}): ProviderRequestHeadersResolver =>
  async (providerConfig) => {
    if (!isLedgerEndpoint(providerConfig.baseUrl)) return undefined
    if (!input.ledgerIdentity) return undefined
    return input.ledgerIdentity.requestHeaders(input.attribution, {
      requireUoaIdentity: true,
    })
  }
