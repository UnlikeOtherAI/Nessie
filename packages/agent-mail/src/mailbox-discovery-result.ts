import {
  MailboxDiscoveryResultSchema,
  type MailboxAuthenticationStrategy,
  type MailboxConnectorRecommendation,
  type MailboxDiscoveryEvidence,
  type MailboxDiscoveryResult,
  type MailboxProviderFamily,
} from '@nessie/schemas'

import type { MailboxProviderRegistryEntry } from './provider-registry.js'
import type { ConfigCandidate } from './mailbox-discovery-evidence.js'

/**
 * The four shapes discovery is allowed to answer with.
 *
 * Every one of them is built through `MailboxDiscoveryResultSchema.parse`, so a
 * field that would leak a hostname, a certificate detail or a probe error
 * cannot be added by accident on the way out — this value crosses to a browser.
 * `trustedImapSmtp` is the only property that authorises the compact password
 * screen, which is why it is passed in rather than derived: the caller decides
 * that a configuration earned it, and a builder can only ever narrow it.
 */

/** A capability means the OAuth adapter and its deployment registration both exist. */
export type MailboxDiscoveryCapabilities = {
  appleAuthorization: boolean
  google: boolean
  jmap: boolean
  microsoft: boolean
}

export const defaultCapabilities: MailboxDiscoveryCapabilities = {
  appleAuthorization: false,
  google: false,
  jmap: false,
  microsoft: false,
}

type ResultIdentity = {
  domain: string
  email: string
  evidence: MailboxDiscoveryEvidence[]
}

export const recommendation = (
  type: MailboxConnectorRecommendation['type'],
  available: boolean,
): MailboxConnectorRecommendation => ({
  available,
  type,
  unavailableReason: available ? null : 'not_configured',
})

export const capabilityFor = (
  family: MailboxProviderFamily,
  capabilities: MailboxDiscoveryCapabilities,
): boolean => family === 'google' ? capabilities.google
  : family === 'microsoft' ? capabilities.microsoft
    : family === 'apple' ? capabilities.appleAuthorization : false

export const providerResult = (input: ResultIdentity & {
  candidate: MailboxProviderRegistryEntry
  capabilities: MailboxDiscoveryCapabilities
  confidence: number
  credentialDestinationTrust?: number
  includeTrustedImapSmtp?: boolean
  requiresProviderConfirmation: boolean
}): MailboxDiscoveryResult => {
  const { candidate, capabilities } = input
  const oauthAvailable = capabilityFor(candidate.family, capabilities)
  const appleAuthorization = candidate.family === 'apple' && oauthAvailable
  const nativeOauth = candidate.authentication === 'oauth2'
  const oauth = nativeOauth && oauthAvailable
  const authentication: MailboxAuthenticationStrategy = appleAuthorization
    ? 'apple_authorization'
    : nativeOauth ? 'oauth2' : candidate.authentication
  const preferred = (appleAuthorization || nativeOauth) && candidate.oauthConnector
    ? recommendation(candidate.oauthConnector, oauthAvailable)
    : recommendation('imap_smtp', true)
  return MailboxDiscoveryResultSchema.parse({
    authentication: {
      available: appleAuthorization || oauth || !nativeOauth,
      strategy: authentication,
      unavailableReason: appleAuthorization || oauth || !nativeOauth ? null : 'not_configured',
    },
    configurationConfidence: input.confidence,
    credentialDestinationTrust: input.credentialDestinationTrust
      ?? (input.requiresProviderConfirmation ? 0.45 : 1),
    domain: input.domain,
    email: input.email,
    evidence: input.evidence,
    fallbackConnectors: preferred.type === 'imap_smtp' ? [] : [recommendation('imap_smtp', true)],
    preferredConnector: preferred,
    provider: candidate.family,
    ...(input.includeTrustedImapSmtp !== false && !input.requiresProviderConfirmation
      ? { trustedImapSmtp: candidate.passwordConfig } : {}),
    ui: {
      providerIcon: candidate.icon,
      providerName: candidate.displayName,
      requiresAdvancedSettings: nativeOauth && !oauthAvailable,
      requiresManualSettings: false,
      requiresProviderConfirmation: input.requiresProviderConfirmation,
    },
  })
}

/** The compact password screen: a configuration we found *and* are willing to trust. */
export const passwordResult = (input: ResultIdentity & {
  candidate: ConfigCandidate
  credentialDestinationTrust: number
}): MailboxDiscoveryResult => MailboxDiscoveryResultSchema.parse({
  authentication: { available: true, strategy: 'password', unavailableReason: null },
  configurationConfidence: input.candidate.confidence,
  credentialDestinationTrust: input.credentialDestinationTrust,
  domain: input.domain,
  email: input.email,
  evidence: input.evidence,
  fallbackConnectors: [recommendation('manual', true)],
  preferredConnector: recommendation('imap_smtp', true),
  provider: 'generic',
  trustedImapSmtp: input.candidate.config,
  ui: {
    providerIcon: 'generic',
    providerName: input.candidate.providerName,
    requiresAdvancedSettings: false,
    requiresManualSettings: false,
    requiresProviderConfirmation: false,
  },
})

/** JMAP is preferred where the deployment has it; the IMAP fallback stays optional. */
export const jmapResult = (input: ResultIdentity & {
  available: boolean
  candidate: ConfigCandidate | null
}): MailboxDiscoveryResult => MailboxDiscoveryResultSchema.parse({
  authentication: {
    available: input.available,
    strategy: 'password',
    unavailableReason: input.available ? null : 'not_supported',
  },
  configurationConfidence: 0.9,
  credentialDestinationTrust: 1,
  domain: input.domain,
  email: input.email,
  evidence: input.evidence,
  fallbackConnectors: [recommendation(input.candidate ? 'imap_smtp' : 'manual', true)],
  preferredConnector: recommendation('jmap', input.available),
  provider: 'generic',
  ...(input.candidate ? { trustedImapSmtp: input.candidate.config } : {}),
  ui: {
    providerIcon: 'generic',
    providerName: 'Email provider',
    requiresAdvancedSettings: false,
    requiresManualSettings: !input.candidate,
    requiresProviderConfirmation: false,
  },
})

/**
 * The recovery path. It carries no `trustedImapSmtp` by construction, so a
 * result that reaches here can never authorise the password screen — whether it
 * got here from contradictory evidence, from nothing at all, or from a
 * configuration the capability probe could not reach securely.
 */
export const manualResult = (input: ResultIdentity & {
  confidence: number
  provider: Extract<MailboxProviderFamily, 'generic' | 'unknown'>
  providerName: string
  requiresProviderConfirmation: boolean
}): MailboxDiscoveryResult => MailboxDiscoveryResultSchema.parse({
  authentication: { available: true, strategy: 'manual', unavailableReason: null },
  configurationConfidence: input.confidence,
  credentialDestinationTrust: 0,
  domain: input.domain,
  email: input.email,
  evidence: input.evidence,
  fallbackConnectors: [],
  preferredConnector: recommendation('manual', true),
  provider: input.provider,
  ui: {
    providerIcon: 'generic',
    providerName: input.providerName,
    requiresAdvancedSettings: false,
    requiresManualSettings: true,
    requiresProviderConfirmation: input.requiresProviderConfirmation,
  },
})
