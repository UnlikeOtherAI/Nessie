import type { MailboxDiscoveryResult } from '@nessie/schemas'

/**
 * What a discovery attempt is allowed to say about itself in the log.
 *
 * The funnel worth measuring is the *outcome*: how often an address alone was
 * enough, how often a person was asked to confirm a provider, and how often
 * discovery gave up and sent them to the manual form. Counting only completed
 * connections hides exactly the failure this design exists to remove.
 *
 * The privacy rule is the reason this is a function rather than a log call at
 * the route: a mailbox address is a person, so only the **domain** and already
 * categorical facts leave here. Confidences become buckets because the raw
 * numbers come from a small set of constants and would only narrow which branch
 * a named domain took. There is no field here a credential could reach.
 */

export type MailboxDiscoveryOutcome =
  | 'existing_connection'
  | 'manual'
  | 'password'
  | 'provider_confirmation'
  | 'provider_oauth'

export type MailboxDiscoveryConfidenceBand = 'none' | 'low' | 'medium' | 'high'

export type MailboxDiscoveryTelemetry = {
  configurationConfidence: MailboxDiscoveryConfidenceBand
  credentialDestinationTrust: MailboxDiscoveryConfidenceBand
  domain: string
  /** True when the server offered a reviewed configuration a password may reach. */
  offeredCredentialDestination: boolean
  outcome: MailboxDiscoveryOutcome
  provider: MailboxDiscoveryResult['provider']
  /** Which discovery methods spoke, so a regression names its own source. */
  sources: string[]
}

const band = (value: number): MailboxDiscoveryConfidenceBand =>
  value >= 0.9 ? 'high' : value >= 0.6 ? 'medium' : value > 0 ? 'low' : 'none'

export const mailboxDiscoveryOutcome = (
  result: MailboxDiscoveryResult,
): MailboxDiscoveryOutcome => {
  if (result.existingConnection) return 'existing_connection'
  if (result.ui.requiresManualSettings) return 'manual'
  if (result.ui.requiresProviderConfirmation) return 'provider_confirmation'
  if (result.authentication.strategy === 'oauth2' && result.authentication.available) {
    return 'provider_oauth'
  }
  // A recognised OAuth provider whose adapter this deployment never configured
  // still carries a reviewed fallback configuration, but the person is sent to
  // advanced settings rather than a one-password screen. Counting that as
  // `password` would inflate the very outcome this funnel exists to watch.
  if (result.ui.requiresAdvancedSettings) return 'manual'
  return result.trustedImapSmtp ? 'password' : 'manual'
}

export const mailboxDiscoveryTelemetry = (
  result: MailboxDiscoveryResult,
): MailboxDiscoveryTelemetry => ({
  configurationConfidence: band(result.configurationConfidence),
  credentialDestinationTrust: band(result.credentialDestinationTrust),
  domain: result.domain,
  offeredCredentialDestination: Boolean(result.trustedImapSmtp),
  outcome: mailboxDiscoveryOutcome(result),
  provider: result.provider,
  sources: [...new Set(result.evidence.map((item) => item.source))].sort(),
})
