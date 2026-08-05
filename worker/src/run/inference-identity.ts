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
 */
export const createProviderRequestHeadersResolver = (input: {
  attribution: LedgerAttribution
  ledgerIdentity?: LedgerIdentityService | null
}): ProviderRequestHeadersResolver =>
  async (providerConfig) => {
    if (!isLedgerEndpoint(providerConfig.baseUrl)) return undefined
    if (!input.ledgerIdentity) {
      throw new Error(
        'Ledger identity service is unavailable for routed inference.',
      )
    }
    return input.ledgerIdentity.requestHeaders(input.attribution, {
      requireUoaIdentity: true,
    })
  }
