import type {
  MailboxAuthenticationStrategy,
  MailboxConnectorType,
  MailboxProviderFamily,
  TrustedMailboxImapSmtpConfig,
} from '@nessie/schemas'

/**
 * Reviewed provider metadata, versioned independently from discovery logic.
 * An MX match is intentionally only a classification signal; it is never a
 * password-destination trust decision by itself.
 */
export const MAILBOX_PROVIDER_REGISTRY_VERSION = 1

export type MailboxProviderRegistryEntry = {
  family: Exclude<MailboxProviderFamily, 'generic' | 'unknown'>
  displayName: string
  icon: Exclude<MailboxProviderFamily, 'unknown'>
  domains: readonly string[]
  autodiscoverSuffixes: readonly string[]
  mxSuffixes: readonly string[]
  authentication: MailboxAuthenticationStrategy
  oauthConnector?: Extract<MailboxConnectorType, 'apple_mail' | 'gmail_api' | 'microsoft_graph'>
  passwordConfig: TrustedMailboxImapSmtpConfig
}

const config = (
  imapHost: string,
  imapPort: number,
  imapSecurity: 'tls' | 'starttls',
  smtpHost: string,
  smtpPort: number,
  smtpSecurity: 'tls' | 'starttls',
): TrustedMailboxImapSmtpConfig => ({
  imap: { host: imapHost, port: imapPort, security: imapSecurity },
  smtp: { host: smtpHost, port: smtpPort, security: smtpSecurity },
  username: 'email_address',
})

export const MAILBOX_PROVIDER_REGISTRY: readonly MailboxProviderRegistryEntry[] = [
  {
    authentication: 'oauth2',
    displayName: 'Google',
    autodiscoverSuffixes: [],
    domains: ['gmail.com', 'googlemail.com'],
    family: 'google',
    icon: 'google',
    mxSuffixes: ['google.com', 'googlemail.com'],
    oauthConnector: 'gmail_api',
    passwordConfig: config(
      'imap.gmail.com', 993, 'tls',
      'smtp.gmail.com', 465, 'tls',
    ),
  },
  {
    authentication: 'oauth2',
    displayName: 'Microsoft',
    autodiscoverSuffixes: ['autodiscover.outlook.com', 'autodiscover-s.outlook.com'],
    domains: ['hotmail.com', 'live.com', 'msn.com', 'outlook.com'],
    family: 'microsoft',
    icon: 'microsoft',
    mxSuffixes: ['mail.protection.outlook.com', 'outlook.com'],
    oauthConnector: 'microsoft_graph',
    passwordConfig: config(
      'outlook.office365.com', 993, 'tls',
      'smtp.office365.com', 587, 'starttls',
    ),
  },
  {
    authentication: 'app_password',
    displayName: 'iCloud',
    autodiscoverSuffixes: [],
    domains: ['icloud.com', 'mac.com', 'me.com'],
    family: 'apple',
    icon: 'apple',
    mxSuffixes: ['icloud.com', 'me.com'],
    oauthConnector: 'apple_mail',
    passwordConfig: config(
      'imap.mail.me.com', 993, 'tls',
      'smtp.mail.me.com', 587, 'starttls',
    ),
  },
  {
    authentication: 'app_password',
    displayName: 'Fastmail',
    autodiscoverSuffixes: [],
    domains: ['fastmail.com', 'fastmail.fm'],
    family: 'fastmail',
    icon: 'fastmail',
    mxSuffixes: ['messagingengine.com'],
    passwordConfig: config(
      'imap.fastmail.com', 993, 'tls',
      'smtp.fastmail.com', 465, 'tls',
    ),
  },
  {
    authentication: 'app_password',
    displayName: 'Yahoo Mail',
    autodiscoverSuffixes: [],
    domains: ['rocketmail.com', 'yahoo.com', 'ymail.com'],
    family: 'yahoo',
    icon: 'yahoo',
    mxSuffixes: ['yahoodns.net', 'yahoo.com'],
    passwordConfig: config(
      'imap.mail.yahoo.com', 993, 'tls',
      'smtp.mail.yahoo.com', 465, 'tls',
    ),
  },
  {
    authentication: 'app_password',
    displayName: 'Zoho Mail',
    autodiscoverSuffixes: [],
    domains: ['zoho.com', 'zohomail.com'],
    family: 'zoho',
    icon: 'zoho',
    mxSuffixes: ['zoho.com'],
    passwordConfig: config(
      'imap.zoho.com', 993, 'tls',
      'smtp.zoho.com', 465, 'tls',
    ),
  },
]

export const providerForDomain = (
  domain: string,
  registry = MAILBOX_PROVIDER_REGISTRY,
): MailboxProviderRegistryEntry | undefined =>
  registry.find((entry) => entry.domains.includes(domain))

export const providerForMx = (
  exchange: string,
  registry = MAILBOX_PROVIDER_REGISTRY,
): MailboxProviderRegistryEntry | undefined => {
  const hostname = exchange.toLowerCase().replace(/\.+$/, '')
  return registry.find((entry) =>
    entry.mxSuffixes.some((suffix) => hostname === suffix || hostname.endsWith(`.${suffix}`)),
  )
}

export const providerForAutodiscover = (
  target: string,
  registry = MAILBOX_PROVIDER_REGISTRY,
): MailboxProviderRegistryEntry | undefined => {
  const hostname = target.toLowerCase().replace(/\.+$/, '')
  return registry.find((entry) => entry.autodiscoverSuffixes.some(
    (suffix) => hostname === suffix || hostname.endsWith(`.${suffix}`),
  ))
}

export const providerForPasswordConfig = (
  candidate: TrustedMailboxImapSmtpConfig,
  registry = MAILBOX_PROVIDER_REGISTRY,
): MailboxProviderRegistryEntry | undefined =>
  registry.find(
    (entry) => (
      entry.passwordConfig.imap.host === candidate.imap.host
      && entry.passwordConfig.imap.port === candidate.imap.port
      && entry.passwordConfig.imap.security === candidate.imap.security
      && entry.passwordConfig.smtp.host === candidate.smtp.host
      && entry.passwordConfig.smtp.port === candidate.smtp.port
      && entry.passwordConfig.smtp.security === candidate.smtp.security
      && entry.passwordConfig.username === candidate.username
    ),
  )
