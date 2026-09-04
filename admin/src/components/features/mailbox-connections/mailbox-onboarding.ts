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

type MailboxProviderFamily = MailboxDiscoveryResult['provider']

/**
 * Where a person actually issues an app-specific password, taken from each
 * provider's own current documentation rather than from a pattern. A provider
 * whose page has not been verified is deliberately absent: guidance with no
 * link is a smaller failure than guidance with a wrong one.
 */
export const appPasswordPages: Partial<Record<MailboxProviderFamily, string>> = {
  apple: 'https://account.apple.com',
  fastmail: 'https://app.fastmail.com/settings/security',
  google: 'https://myaccount.google.com/apppasswords',
  yahoo: 'https://login.yahoo.com/account/security',
  zoho: 'https://accounts.zoho.com',
}

export const appPasswordPageUrl = (result: MailboxDiscoveryResult): string | null =>
  appPasswordPages[result.provider] ?? null

export const providerMark = (icon: string, providerName: string): string => {
  switch (icon) {
    case 'google':
      return 'G'
    case 'microsoft':
      return 'M'
    case 'icloud':
    case 'apple':
      return 'i'
    default:
      return providerName.slice(0, 1).toUpperCase() || '?'
  }
}

type CodedError = { code?: string; message?: string }

/**
 * The code a person may quote to support: upper-cased, punctuation folded to
 * `_`, and length-capped, so a provider string can never smuggle markup or a
 * paragraph of server detail into the technical-details disclosure.
 */
export const mailboxErrorCode = (cause: unknown): string | null => {
  if (typeof cause !== 'object' || cause === null || !('code' in cause)) return null
  const raw = String((cause as CodedError).code ?? '')
  const code = raw.trim().toUpperCase().replace(/[^A-Z0-9_]+/g, '_').replace(/^_+|_+$/g, '')
  return code ? code.slice(0, 64) : null
}

export const mailboxErrorMessage = (cause: unknown, fallback: string): string => {
  switch (mailboxErrorCode(cause) ?? '') {
    case 'INVALID_EMAIL_ADDRESS':
      return 'Enter a valid email address.'
    case 'ADDRESS_TAKEN':
    case 'ALREADY_CONNECTED':
      return 'This email account is already connected.'
    case 'CREDENTIAL_REJECTED':
    case 'AUTH_FAILED':
      return 'Your email address or password was not accepted.'
    case 'APP_PASSWORD_REQUIRED':
    case 'APPLICATION_PASSWORD_REQUIRED':
      return 'This provider requires an app-specific password.'
    case 'TEST_FAILED':
      return 'Could not complete the mailbox connection test.'
    case 'OAUTH_CANCELLED':
    case 'OAUTH_CANCELED':
    case 'AUTHORIZATION_CANCELLED':
    case 'USER_CANCELLED':
      return 'Connection wasn\'t completed.'
    case 'ACCESS_DENIED':
    case 'CONSENT_DENIED':
    case 'CONSENT_REQUIRED':
    case 'SCOPES_DENIED':
      return 'We need permission to access your email to connect this account.'
    case 'ADMIN_BLOCKED':
    case 'ADMIN_CONSENT_REQUIRED':
    case 'APP_BLOCKED':
    case 'TENANT_POLICY_BLOCKED':
      return 'Your organisation doesn\'t currently allow this app to access email.'
    case 'PROVIDER_UNAVAILABLE':
    case 'PROVIDER_OUTAGE':
    case 'RATE_LIMITED':
    case 'TOO_MANY_REQUESTS':
      return 'Your email provider is temporarily unavailable.'
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
    default:
      return fallback
  }
}

/** Domain only. The local part is never diagnostic and is nobody's business. */
export const mailboxAddressDomain = (address: string): string | null => {
  const at = address.lastIndexOf('@')
  if (at <= 0) return null
  const domain = address.slice(at + 1).trim().toLowerCase()
  return domain || null
}

const confidencePercent = (value: number): string =>
  `${Math.round(Math.min(Math.max(value, 0), 1) * 100)}%`

const evidenceSummary = (result: MailboxDiscoveryResult): string =>
  result.evidence.length === 0
    ? 'none'
    : result.evidence
      .map((entry) => `${entry.source} ${entry.score}${entry.trustedForCredentials ? ' trusted' : ''}`)
      .join(', ')

/**
 * What support needs and nothing more: the sanitised code, the domain, and the
 * server's own confidence and evidence. No credential and no full address ever
 * reaches these lines, because neither is passed in.
 */
export const mailboxTechnicalDetails = (input: {
  address: string
  code: string | null
  result: MailboxDiscoveryResult | null
}): string[] => {
  const lines: string[] = []
  if (input.code) lines.push(`Error code: ${input.code}`)
  const domain = input.result?.domain ?? mailboxAddressDomain(input.address)
  if (domain) lines.push(`Domain: ${domain}`)
  if (input.result) {
    lines.push(`Configuration confidence: ${confidencePercent(input.result.configurationConfidence)}`)
    lines.push(
      `Credential destination trust: ${confidencePercent(input.result.credentialDestinationTrust)}`,
    )
    lines.push(`Evidence: ${evidenceSummary(input.result)}`)
  }
  return lines
}
