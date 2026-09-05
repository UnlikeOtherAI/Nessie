import { faApple, faGoogle, faMicrosoft, faYahoo } from '@fortawesome/free-brands-svg-icons'
import { faEnvelope } from '@fortawesome/free-solid-svg-icons'
import type { IconDefinition } from '@fortawesome/fontawesome-svg-core'

import type { MailboxConnectionScope, MailboxDiscoveryResult } from '../../../lib/api-client'

/**
 * The discovery endpoint is deliberately described here instead of spread
 * through the UI. The server owns its evidence and trust decision; this file
 * only turns that decision into the next screen a person should see.
 */
export type MailboxOnboardingStep =
  | 'start'
  | 'existing'
  | 'confirmation'
  | 'password'
  | 'manual'
  | 'shared-credential'

export const shouldDiscoverMailbox = (screen: MailboxOnboardingStep): boolean => screen === 'start'

/** Syntactic only: this enables Continue, not a claim that an address exists. */
export const isUsableEmailAddress = (value: string): boolean =>
  /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim())

export const isHighConfidenceDiscovery = (result: MailboxDiscoveryResult): boolean =>
  !result.ui.requiresManualSettings
  && !result.ui.requiresProviderConfirmation

/**
 * The server withholds this property until both confidence and destination
 * trust are sufficient. The browser must not apply a second policy threshold.
 */
export const hasTrustedMailboxConfiguration = (result: MailboxDiscoveryResult): boolean =>
  result.trustedImapSmtp !== undefined
  && result.trustedImapSmtp !== null

/**
 * Google/Microsoft labels do not imply an OAuth registration. The discovery
 * service must explicitly select the Comms adapter before this flow may start
 * an OAuth window.
 */
export const commsOAuthProvider = (
  result: MailboxDiscoveryResult,
  scope: MailboxConnectionScope,
): 'google' | 'microsoft' | null => {
  if (
    scope !== 'user'
    || result.authentication.strategy !== 'oauth2'
    || !result.authentication.available
  ) {
    return null
  }
  return result.provider === 'google' || result.provider === 'microsoft'
    ? result.provider
    : null
}

export const nextMailboxOnboardingStep = (
  result: MailboxDiscoveryResult,
  scope: MailboxConnectionScope,
): MailboxOnboardingStep => {
  if (result.existingConnection) return 'existing'
  if (result.ui.requiresManualSettings) return 'manual'
  if (result.ui.requiresProviderConfirmation) return 'confirmation'
  if (commsOAuthProvider(result, scope)) return 'start'
  if (scope === 'team' && result.authentication.strategy === 'oauth2') return 'shared-credential'
  if (result.ui.requiresAdvancedSettings) return 'shared-credential'
  if (hasTrustedMailboxConfiguration(result)) return 'password'
  return result.authentication.strategy === 'oauth2' ? 'shared-credential' : 'manual'
}

export const connectorMethodLabel = (type: string): string => {
  switch (type) {
    case 'gmail_api':
      return 'Gmail'
    case 'microsoft_graph':
      return 'Microsoft 365'
    case 'jmap':
      return 'JMAP'
    case 'imap_smtp':
      return 'Secure mail server'
    default:
      return 'Email'
  }
}

export const unavailableAuthenticationMessage = (result: MailboxDiscoveryResult): string => {
  switch (result.authentication.unavailableReason) {
    case 'not_configured':
      return 'Email sign-in has not been configured in this deployment.'
    case 'not_supported':
      return 'Email sign-in is not supported by this provider.'
    default:
      return `This ${result.ui.providerName} mailbox needs a secure server credential `
        + 'before it can be connected.'
  }
}

export const appPasswordAccountName = (result: MailboxDiscoveryResult): string =>
  result.provider === 'apple' ? 'Apple Account' : `${result.ui.providerName} account`

/**
 * The mark shown beside a provider. The keys are discovery's `ui.providerIcon`
 * values plus `icloud`, which the address screen's shortcut rows use directly;
 * a provider with no brand mark (Fastmail, Zoho, anything unrecognised) falls
 * back to the envelope rather than to an initial, so no row renders a letter
 * where its neighbours render a logo.
 */
const PROVIDER_ICONS: Record<string, IconDefinition> = {
  apple: faApple,
  google: faGoogle,
  icloud: faApple,
  microsoft: faMicrosoft,
  yahoo: faYahoo,
}

export const providerIcon = (icon: string): IconDefinition =>
  PROVIDER_ICONS[icon] ?? faEnvelope

type CodedError = { code?: string; message?: string }

export const mailboxErrorMessage = (cause: unknown, fallback: string): string => {
  const code = typeof cause === 'object' && cause !== null && 'code' in cause
    ? String((cause as CodedError).code ?? '').toUpperCase()
    : ''

  switch (code) {
    case 'INVALID_EMAIL_ADDRESS':
      return 'Enter a valid email address.'
    case 'ADDRESS_TAKEN':
    case 'ALREADY_CONNECTED':
      return 'This email account is already connected.'
    case 'CREDENTIAL_REJECTED':
    case 'AUTH_FAILED':
      return 'Your email address or password was not accepted.'
    case 'TEST_FAILED':
      return 'Could not complete the mailbox connection test.'
    case 'SERVER_UNAVAILABLE':
    case 'CONNECTION_FAILED':
      return 'We found your email settings, but could not connect to the server.'
    case 'INVALID_CERTIFICATE':
    case 'TLS_FAILED':
    case 'INSECURE_CONNECTION':
      return 'We cannot connect securely to this mail server.'
    case 'DISCOVERY_EXHAUSTED':
    case 'DISCOVERY_FAILED':
      return 'We could not find the settings automatically.'
    // Deployment configuration, not a transient failure: retrying cannot
    // succeed, so the copy must not invite one.
    case 'PROVIDER_NOT_CONFIGURED':
      return 'Sign-in with this provider has not been set up on this Nessie '
        + 'server. An administrator has to register it first.'
    case 'NOT_IMPLEMENTED':
      return 'Connecting this provider is not available yet.'
    case 'PUBLIC_ORIGIN_NOT_CONFIGURED':
      return 'This server does not know its own public address, so sign-in '
        + 'cannot start. An administrator has to set it.'
    default:
      return fallback
  }
}
