import type {
  MailboxDiscoveryEvidence,
  MailboxProviderFamily,
  TrustedMailboxImapSmtpConfig,
} from '@nessie/schemas'

import { providerForPasswordConfig, type MailboxProviderRegistryEntry } from './provider-registry.js'
import { mailboxDiscoveryHostname } from './mailbox-discovery-address.js'
import type { SrvRecord } from './mailbox-discovery-network.js'

/**
 * How discovery weighs what it found.
 *
 * Two decisions live here and they are deliberately separate. *Which provider
 * is this* is a ranking over evidence scores, and a near-tie is a conflict
 * rather than a winner. *May this configuration receive a password* is a trust
 * predicate that scoring cannot influence: an endpoint earns it by being
 * published under the person's own domain, by matching a reviewed provider
 * entry, or by being a reviewed snapshot entry — never by outscoring the
 * alternatives. Keeping the two apart is what stops a loud but untrusted signal
 * from being promoted into a credential destination.
 */

/** Where a candidate configuration came from, strongest evidence first. */
export type ConfigCandidateSource = 'autoconfig' | 'mail_srv' | 'ispdb'

/**
 * Candidate ordering. A domain-controlled autoconfiguration document is the
 * most current statement about a domain, so it outranks our own reviewed
 * snapshot even for a domain the snapshot knows: the provider can change its
 * endpoints without waiting for us to re-verify the entry.
 */
export const CANDIDATE_SCORES: Record<ConfigCandidateSource, number> = {
  autoconfig: 90,
  ispdb: 75,
  mail_srv: 85,
}

export type ConfigCandidate = {
  config: TrustedMailboxImapSmtpConfig
  source: ConfigCandidateSource
  /** Whether this configuration may be offered as a password destination. */
  trusted: boolean
  /** Reported as `configurationConfidence` when this candidate is selected. */
  confidence: number
  /** Reported as `ui.providerName`; a snapshot entry carries its real name. */
  providerName: string
}

export const evidence = (
  source: MailboxDiscoveryEvidence['source'],
  score: number,
  trustedForCredentials: boolean,
  provider?: MailboxProviderFamily,
): MailboxDiscoveryEvidence => ({
  ...(provider ? { provider } : {}),
  score,
  source,
  trustedForCredentials,
})

export const sameDomain = (host: string, domain: string): boolean =>
  host === domain || host.endsWith(`.${domain}`)

export const configTrustedForDomain = (
  config: TrustedMailboxImapSmtpConfig,
  domain: string,
  registry: readonly MailboxProviderRegistryEntry[],
): boolean =>
  (sameDomain(config.imap.host, domain) && sameDomain(config.smtp.host, domain))
  || Boolean(providerForPasswordConfig(config, registry))

export const firstSrv = (records: SrvRecord[] | null): SrvRecord | null => {
  if (!records?.length) return null
  return [...records].sort((a, b) => (
    a.priority - b.priority
    || b.weight - a.weight
    || a.name.localeCompare(b.name)
  ))[0] ?? null
}

export const configFromSrv = (input: {
  imap: SrvRecord | null
  imaps: SrvRecord | null
  submission: SrvRecord | null
  submissions: SrvRecord | null
}): TrustedMailboxImapSmtpConfig | null => {
  const imap = input.imaps ?? input.imap
  const smtp = input.submissions ?? input.submission
  const imapHost = imap ? mailboxDiscoveryHostname(imap.name) : null
  const smtpHost = smtp ? mailboxDiscoveryHostname(smtp.name) : null
  if (!imap || !smtp || !imapHost || !smtpHost) return null
  return {
    imap: {
      host: imapHost,
      port: imap.port,
      security: input.imaps ? 'tls' : 'starttls',
    },
    smtp: {
      host: smtpHost,
      port: smtp.port,
      security: input.submissions ? 'tls' : 'starttls',
    },
    username: 'email_address',
  }
}

/**
 * The best candidate we are willing to send a password to.
 *
 * Ordering is by evidence strength, never by the order the fan-out happened to
 * push results in — a mail SRV record answering first is not a reason to prefer
 * it over the domain's own autoconfiguration document. The trust filter is
 * applied after the sort and is never relaxed by it: an untrusted candidate
 * cannot win by being the only one left.
 */
export const selectTrustedCandidate = (
  candidates: readonly ConfigCandidate[],
): ConfigCandidate | null =>
  [...candidates]
    .sort((a, b) => CANDIDATE_SCORES[b.source] - CANDIDATE_SCORES[a.source])
    .find((candidate) => candidate.trusted) ?? null

/**
 * Which provider the evidence points at, and whether it points clearly enough.
 * Two families within 50 points of each other is a contradiction — a domain
 * whose MX says one provider and whose autoconfig says another is not a domain
 * we may guess about, because the guess decides where a password goes.
 */
export const rankProviders = (
  findings: readonly MailboxDiscoveryEvidence[],
): { topFamily: MailboxProviderFamily | undefined; isConflict: boolean } => {
  const providers = new Map<MailboxProviderFamily, number>()
  for (const item of findings) {
    if (item.provider) providers.set(item.provider, (providers.get(item.provider) ?? 0) + item.score)
  }
  const ranked = [...providers.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  return {
    isConflict: ranked.length > 1 && (ranked[0]?.[1] ?? 0) - (ranked[1]?.[1] ?? 0) < 50,
    topFamily: ranked[0]?.[0],
  }
}
