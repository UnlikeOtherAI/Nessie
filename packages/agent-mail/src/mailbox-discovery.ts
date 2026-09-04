import type {
  MailboxDiscoveryEvidence,
  MailboxDiscoveryResult,
} from '@nessie/schemas'
import { safeFetch } from '@nessie/runtime'

import {
  MAILBOX_PROVIDER_REGISTRY,
  providerForAutodiscover,
  providerForDomain,
  providerForMx,
  providerForPasswordConfig,
  type MailboxProviderRegistryEntry,
} from './provider-registry.js'
import {
  mailboxDiscoveryHostname,
  parseMailboxDiscoveryAddress,
} from './mailbox-discovery-address.js'
import { parseMailboxAutoconfig } from './mailbox-autoconfig.js'
import { ispdbForDomain } from './mailbox-ispdb.js'
import { probeMailboxCapability, type MailboxCapabilityProbe } from './mailbox-probe.js'
import {
  DISCOVERY_TIMEOUT_MS,
  defaultDns,
  defaultTimeout,
  discoveryFetch,
  settled,
  type MailboxDiscoveryDns,
  type MailboxDiscoveryFetch,
  type MailboxDiscoveryTimeout,
} from './mailbox-discovery-network.js'
import {
  CANDIDATE_SCORES,
  configFromSrv,
  configTrustedForDomain,
  evidence,
  firstSrv,
  rankProviders,
  sameDomain,
  selectTrustedCandidate,
  type ConfigCandidate,
} from './mailbox-discovery-evidence.js'
import {
  capabilityFor,
  defaultCapabilities,
  jmapResult,
  manualResult,
  passwordResult,
  providerResult,
  type MailboxDiscoveryCapabilities,
} from './mailbox-discovery-result.js'

/**
 * Address-first mailbox discovery: an email address in, a provider
 * classification out, plus — only when the evidence earns it — the one
 * `trustedImapSmtp` property that authorises the compact password screen.
 *
 * This file is the orchestrator. It owns the order things happen in and
 * nothing else: the network fan-out is `mailbox-discovery-network.ts`, how
 * findings are weighed is `mailbox-discovery-evidence.ts`, and the shapes it
 * may answer with are `mailbox-discovery-result.ts`.
 */

export { MailboxDiscoveryAddressError, parseMailboxDiscoveryAddress } from './mailbox-discovery-address.js'
export type {
  MailboxDiscoveryDns,
  MailboxDiscoveryFetch,
  MailboxDiscoveryTimeout,
} from './mailbox-discovery-network.js'
export type { MailboxDiscoveryCapabilities } from './mailbox-discovery-result.js'

/** Every generic path answers with the same neutral name; only a curated entry has a real one. */
const GENERIC_PROVIDER_NAME = 'Email provider'

export type MailboxDiscoveryDeps = {
  capabilities?: Partial<MailboxDiscoveryCapabilities>
  clock?: () => number
  dns?: Partial<MailboxDiscoveryDns>
  fetch?: MailboxDiscoveryFetch
  /** Injected so a test never opens a socket; production confirms for real. */
  probe?: MailboxCapabilityProbe
  registry?: readonly MailboxProviderRegistryEntry[]
  timeout?: MailboxDiscoveryTimeout
}

export const createMailboxDiscoveryService = (deps: MailboxDiscoveryDeps = {}) => {
  const dns: MailboxDiscoveryDns = { ...defaultDns, ...deps.dns }
  const runFetch = deps.fetch ?? safeFetch
  const registry = deps.registry ?? MAILBOX_PROVIDER_REGISTRY
  const capabilities = { ...defaultCapabilities, ...deps.capabilities }
  const clock = deps.clock ?? Date.now
  const timeout = deps.timeout ?? defaultTimeout
  const probe = deps.probe ?? probeMailboxCapability

  return async (rawEmail: string): Promise<MailboxDiscoveryResult> => {
    const parsed = parseMailboxDiscoveryAddress(rawEmail)
    const exact = providerForDomain(parsed.domain, registry)
    // Mainstream identities are reviewed facts, so they never wait on a DNS or
    // HTTPS probe that can only make their Apple-simple path slower. Nothing
    // here dials either: a reviewed configuration is not a network question.
    if (exact) {
      return providerResult({
        candidate: exact,
        capabilities,
        confidence: 0.99,
        domain: parsed.domain,
        email: parsed.email,
        evidence: [evidence('provider_registry', 100, true, exact.family)],
        requiresProviderConfirmation: false,
      })
    }
    const deadline = clock() + DISCOVERY_TIMEOUT_MS
    const withinDeadline = <T>(operation: Promise<T>): Promise<T | null> =>
      settled(operation, timeout, deadline - clock())
    const autoconfigUrls = [
      new URL(`https://${parsed.domain}/.well-known/autoconfig/mail/config-v1.1.xml?emailaddress=${encodeURIComponent(parsed.email)}`),
      new URL(`https://autoconfig.${parsed.domain}/mail/config-v1.1.xml?emailaddress=${encodeURIComponent(parsed.email)}`),
    ]
    const jmapUrl = new URL(`https://${parsed.domain}/.well-known/jmap`)
    const [mx, imaps, imap, submissions, submission, jmapSrv, autodiscover, xmlBodies, jmapBody] = await Promise.all([
      withinDeadline(dns.mx(parsed.domain)),
      withinDeadline(dns.srv(`_imaps._tcp.${parsed.domain}`)),
      withinDeadline(dns.srv(`_imap._tcp.${parsed.domain}`)),
      withinDeadline(dns.srv(`_submissions._tcp.${parsed.domain}`)),
      withinDeadline(dns.srv(`_submission._tcp.${parsed.domain}`)),
      withinDeadline(dns.srv(`_jmap._tcp.${parsed.domain}`)),
      withinDeadline(dns.srv(`_autodiscover._tcp.${parsed.domain}`)),
      Promise.all(autoconfigUrls.map((url) => discoveryFetch(runFetch, url, withinDeadline))),
      discoveryFetch(runFetch, jmapUrl, withinDeadline),
    ])
    const jmapSrvTarget = firstSrv(jmapSrv)
    const jmapSrvHost = jmapSrvTarget ? mailboxDiscoveryHostname(jmapSrvTarget.name) : null
    // An SRV record owned by another domain is useful evidence, but cannot
    // independently earn the right to receive an eventual mailbox secret.
    const jmapSrvBody = jmapSrvHost && jmapSrvTarget && sameDomain(jmapSrvHost, parsed.domain)
      ? await discoveryFetch(
        runFetch,
        new URL(`https://${jmapSrvHost}:${jmapSrvTarget.port}/.well-known/jmap`),
        withinDeadline,
      )
      : null

    const findings: MailboxDiscoveryEvidence[] = []
    const mxProviders = (mx ?? [])
      .map((record) => providerForMx(record.exchange, registry))
      .filter((entry): entry is MailboxProviderRegistryEntry => Boolean(entry))
    for (const provider of new Map(mxProviders.map((entry) => [entry.family, entry])).values()) {
      findings.push(evidence('mx_fingerprint', 55, false, provider.family))
    }

    const candidates: ConfigCandidate[] = []
    // The curated snapshot is a *candidate*, never a short circuit: a document
    // the domain publishes today is more current than a settings page we read
    // once, so the fan-out above still runs and autoconfig still outranks this.
    const curated = ispdbForDomain(parsed.domain)
    if (curated) {
      findings.push(evidence('ispdb', CANDIDATE_SCORES.ispdb, true))
      candidates.push({
        config: curated.config,
        confidence: 0.9,
        providerName: curated.displayName,
        source: 'ispdb',
        trusted: true,
      })
    }

    const srvConfig = configFromSrv({
      imap: firstSrv(imap),
      imaps: firstSrv(imaps),
      submission: firstSrv(submission),
      submissions: firstSrv(submissions),
    })
    if (srvConfig) {
      const trusted = configTrustedForDomain(srvConfig, parsed.domain, registry)
      findings.push(evidence('mail_srv', trusted ? CANDIDATE_SCORES.mail_srv : 45, trusted))
      candidates.push({
        config: srvConfig,
        confidence: 0.85,
        providerName: GENERIC_PROVIDER_NAME,
        source: 'mail_srv',
        trusted,
      })
    }
    const autodiscoverProvider = autodiscover
      ?.map((record) => providerForAutodiscover(record.name, registry))
      .find((entry): entry is MailboxProviderRegistryEntry => Boolean(entry))
    if (autodiscoverProvider) {
      // This recognises Exchange Online routing only. It does not fetch an
      // Autodiscover document and cannot itself create a password destination.
      findings.push(evidence('autodiscover_srv', 75, false, autodiscoverProvider.family))
    } else if (autodiscover?.length) {
      findings.push(evidence('autodiscover_srv', 20, false))
    }
    if (jmapSrv?.length) findings.push(evidence('jmap_srv', jmapSrvBody ? 70 : 45, Boolean(jmapSrvBody)))

    const seenAutoconfig = new Set<string>()
    for (const xml of xmlBodies) {
      if (!xml) continue
      const config = parseMailboxAutoconfig(xml)
      if (!config) continue
      const key = JSON.stringify(config)
      if (seenAutoconfig.has(key)) continue
      seenAutoconfig.add(key)
      const trusted = configTrustedForDomain(config, parsed.domain, registry)
      const matchedProvider = providerForPasswordConfig(config, registry)
      findings.push(evidence('autoconfig', trusted ? CANDIDATE_SCORES.autoconfig : 45, trusted, matchedProvider?.family))
      candidates.push({
        config,
        confidence: 0.9,
        providerName: GENERIC_PROVIDER_NAME,
        source: 'autoconfig',
        trusted,
      })
    }

    const jmapValid = (body: string | null, expectedHost: string): boolean => {
      if (!body) return false
      try {
        const apiUrl = JSON.parse(body) as { apiUrl?: unknown }
        const parsedUrl = typeof apiUrl.apiUrl === 'string' ? new URL(apiUrl.apiUrl) : null
        return Boolean(parsedUrl && parsedUrl.protocol === 'https:' && mailboxDiscoveryHostname(parsedUrl.hostname)
          && sameDomain(parsedUrl.hostname, expectedHost))
      } catch {
        return false
      }
    }
    const directJmapValid = jmapValid(jmapBody, parsed.domain)
    const srvJmapValid = jmapValid(jmapSrvBody, jmapSrvHost ?? parsed.domain)
    const hasTrustedJmap = directJmapValid || srvJmapValid
    if (hasTrustedJmap) findings.push(evidence('jmap_session', 90, true))

    const { isConflict, topFamily } = rankProviders(findings)
    if (isConflict) findings.push(evidence('conflict', -45, false))

    if (topFamily && !isConflict) {
      const selected = registry.find((entry) => entry.family === topFamily)
      if (selected) {
        const providerEvidence = findings.filter((item) => item.provider === selected.family)
        const providerCorroborated = providerEvidence.some((item) => item.source !== 'mx_fingerprint')
        const protocolTrusted = providerEvidence.some((item) => item.source === 'autoconfig')
        const base = providerCorroborated ? 0.95 : 0.55
        const fixedOAuthAvailable = (selected.family === 'google' || selected.family === 'microsoft')
          && capabilityFor(selected.family, capabilities)
        return providerResult({
          candidate: selected,
          capabilities,
          confidence: base,
          credentialDestinationTrust: protocolTrusted ? 1 : 0.45,
          domain: parsed.domain,
          email: parsed.email,
          evidence: findings,
          includeTrustedImapSmtp: protocolTrusted,
          requiresProviderConfirmation: !providerCorroborated && !fixedOAuthAvailable,
        })
      }
    }

    const identity = { domain: parsed.domain, email: parsed.email, evidence: findings }
    if (isConflict) {
      return manualResult({
        ...identity,
        confidence: 0.45,
        provider: 'unknown',
        providerName: 'Email services',
        requiresProviderConfirmation: true,
      })
    }

    let selectedCandidate = selectTrustedCandidate(candidates)
    let credentialDestinationTrust = 0.95
    let probeRefused = false
    if (selectedCandidate) {
      // Only the one configuration we already decided to trust is ever dialled.
      const outcome = await probe(selectedCandidate.config, { clientName: parsed.domain })
      if (outcome === 'confirmed') {
        findings.push(evidence('capability_probe', 30, true))
        credentialDestinationTrust = 1
      } else if (outcome === 'insecure') {
        // A destination we cannot reach over a verified TLS session must never
        // authorise a password screen. `unreachable`/`skipped` change nothing:
        // a transient failure is the connect step's error copy to give, not a
        // reason to withhold a reviewed configuration.
        selectedCandidate = null
        probeRefused = true
      }
    }

    if (hasTrustedJmap && capabilities.jmap) {
      return jmapResult({ ...identity, available: capabilities.jmap, candidate: selectedCandidate })
    }
    if (selectedCandidate) {
      return passwordResult({ ...identity, candidate: selectedCandidate, credentialDestinationTrust })
    }
    const externalSrv = candidates.find((candidate) => !candidate.trusted)
    return manualResult({
      ...identity,
      confidence: externalSrv || probeRefused ? 0.45 : 0,
      provider: 'generic',
      providerName: GENERIC_PROVIDER_NAME,
      requiresProviderConfirmation: Boolean(externalSrv),
    })
  }
}
