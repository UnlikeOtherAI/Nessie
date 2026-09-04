import { resolveMx, resolveSrv } from 'node:dns/promises'

import {
  MailboxDiscoveryResultSchema,
  type MailboxAuthenticationStrategy,
  type MailboxConnectorRecommendation,
  type MailboxDiscoveryEvidence,
  type MailboxDiscoveryResult,
  type MailboxProviderFamily,
  type TrustedMailboxImapSmtpConfig,
} from '@nessie/schemas'
import { safeFetch, type SafeFetchOptions } from '@nessie/runtime'

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

export { MailboxDiscoveryAddressError, parseMailboxDiscoveryAddress } from './mailbox-discovery-address.js'

const DISCOVERY_TIMEOUT_MS = 3_000
const DISCOVERY_MAX_BYTES = 64 * 1024
type MxRecord = { exchange: string; priority: number }
type SrvRecord = { name: string; port: number; priority: number; weight: number }
export type MailboxDiscoveryDns = {
  mx: (domain: string) => Promise<MxRecord[]>
  srv: (name: string) => Promise<SrvRecord[]>
}

export type MailboxDiscoveryFetch = (
  url: URL,
  init: RequestInit,
  options: SafeFetchOptions,
) => Promise<Response>

/** Testable deadline seam; the default gives all generic discovery work one budget. */
export type MailboxDiscoveryTimeout = <T>(
  operation: Promise<T>,
  timeoutMs: number,
) => Promise<T | null>

/** A capability means the OAuth adapter and its deployment registration both exist. */
export type MailboxDiscoveryCapabilities = {
  appleAuthorization: boolean
  google: boolean
  jmap: boolean
  microsoft: boolean
}

export type MailboxDiscoveryDeps = {
  capabilities?: Partial<MailboxDiscoveryCapabilities>
  clock?: () => number
  dns?: Partial<MailboxDiscoveryDns>
  fetch?: MailboxDiscoveryFetch
  registry?: readonly MailboxProviderRegistryEntry[]
  timeout?: MailboxDiscoveryTimeout
}

type ProtocolConfig = TrustedMailboxImapSmtpConfig
type ConfigCandidate = { config: ProtocolConfig; source: 'autoconfig' | 'mail_srv'; trusted: boolean }
const defaultDns: MailboxDiscoveryDns = {
  mx: async (domain) => resolveMx(domain),
  srv: async (name) => resolveSrv(name),
}

const defaultCapabilities: MailboxDiscoveryCapabilities = {
  appleAuthorization: false,
  google: false,
  jmap: false,
  microsoft: false,
}

const defaultTimeout: MailboxDiscoveryTimeout = async <T>(operation: Promise<T>, timeoutMs: number) => {
  if (timeoutMs <= 0) return null
  return new Promise<T | null>((resolve) => {
    let complete = false
    const finish = (value: T | null): void => {
      if (complete) return
      complete = true
      clearTimeout(timer)
      resolve(value)
    }
    const timer = setTimeout(() => finish(null), timeoutMs)
    void operation.then((value) => finish(value)).catch(() => finish(null))
  })
}

const settled = async <T>(
  operation: Promise<T>,
  timeout: MailboxDiscoveryTimeout,
  timeoutMs: number,
): Promise<T | null> => {
  try {
    return await timeout(operation, timeoutMs)
  } catch {
    return null
  }
}

const discoveryFetch = async (
  run: MailboxDiscoveryFetch,
  url: URL,
  withinDeadline: <T>(operation: Promise<T>) => Promise<T | null>,
): Promise<string | null> => {
  const response = await withinDeadline(run(url, {
    headers: { Accept: 'application/json, application/xml, text/xml;q=0.9' },
    method: 'GET',
    signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
  }, {
    maxRedirects: 2,
    redirectPolicy: 'same-origin',
  }))
  if (!response || response.status !== 200) return null
  const declared = Number(response.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > DISCOVERY_MAX_BYTES) return null
  const reader = response.body?.getReader()
  if (!reader) return ''
  const chunks: Uint8Array[] = []
  let bytes = 0
  try {
    while (true) {
      // A response can send headers and then hold its body open forever. Keep
      // each read within the same discovery deadline as DNS and connection.
      const next = await withinDeadline(reader.read())
      if (!next) {
        await reader.cancel()
        return null
      }
      if (next.done) break
      bytes += next.value.byteLength
      if (bytes > DISCOVERY_MAX_BYTES) {
        await reader.cancel()
        return null
      }
      chunks.push(next.value)
    }
  } catch {
    return null
  } finally {
    reader.releaseLock()
  }
  const combined = new Uint8Array(bytes)
  let offset = 0
  for (const chunk of chunks) {
    combined.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(combined)
}

const sameDomain = (host: string, domain: string): boolean =>
  host === domain || host.endsWith(`.${domain}`)

const configTrustedForDomain = (
  config: ProtocolConfig,
  domain: string,
  registry: readonly MailboxProviderRegistryEntry[],
): boolean =>
  (sameDomain(config.imap.host, domain) && sameDomain(config.smtp.host, domain))
  || Boolean(providerForPasswordConfig(config, registry))

const firstSrv = (records: SrvRecord[] | null): SrvRecord | null => {
  if (!records?.length) return null
  return [...records].sort((a, b) => (
    a.priority - b.priority
    || b.weight - a.weight
    || a.name.localeCompare(b.name)
  ))[0] ?? null
}

const configFromSrv = (input: {
  imap: SrvRecord | null
  imaps: SrvRecord | null
  submission: SrvRecord | null
  submissions: SrvRecord | null
}): ProtocolConfig | null => {
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

const evidence = (
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

const recommendation = (
  type: MailboxConnectorRecommendation['type'],
  available: boolean,
): MailboxConnectorRecommendation => ({
  available,
  type,
  unavailableReason: available ? null : 'not_configured',
})

const capabilityFor = (
  family: MailboxProviderFamily,
  capabilities: MailboxDiscoveryCapabilities,
): boolean => family === 'google' ? capabilities.google
  : family === 'microsoft' ? capabilities.microsoft
    : family === 'apple' ? capabilities.appleAuthorization : false

const providerResult = (input: {
  candidate: MailboxProviderRegistryEntry
  capabilities: MailboxDiscoveryCapabilities
  confidence: number
  credentialDestinationTrust?: number
  domain: string
  email: string
  evidence: MailboxDiscoveryEvidence[]
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

export const createMailboxDiscoveryService = (deps: MailboxDiscoveryDeps = {}) => {
  const dns: MailboxDiscoveryDns = { ...defaultDns, ...deps.dns }
  const runFetch = deps.fetch ?? safeFetch
  const registry = deps.registry ?? MAILBOX_PROVIDER_REGISTRY
  const capabilities = { ...defaultCapabilities, ...deps.capabilities }
  const clock = deps.clock ?? Date.now
  const timeout = deps.timeout ?? defaultTimeout

  return async (rawEmail: string): Promise<MailboxDiscoveryResult> => {
    const parsed = parseMailboxDiscoveryAddress(rawEmail)
    const exact = providerForDomain(parsed.domain, registry)
    // Mainstream identities are reviewed facts, so they never wait on a DNS or
    // HTTPS probe that can only make their Apple-simple path slower.
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

    const srvConfig = configFromSrv({
      imap: firstSrv(imap),
      imaps: firstSrv(imaps),
      submission: firstSrv(submission),
      submissions: firstSrv(submissions),
    })
    const candidates: ConfigCandidate[] = []
    if (srvConfig) {
      const trusted = configTrustedForDomain(srvConfig, parsed.domain, registry)
      findings.push(evidence('mail_srv', trusted ? 85 : 45, trusted))
      candidates.push({ config: srvConfig, source: 'mail_srv', trusted })
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
      findings.push(evidence('autoconfig', trusted ? 90 : 45, trusted, matchedProvider?.family))
      candidates.push({ config, source: 'autoconfig', trusted })
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

    const providers = new Map<MailboxProviderFamily, number>()
    for (const item of findings) {
      if (item.provider) providers.set(item.provider, (providers.get(item.provider) ?? 0) + item.score)
    }
    const ranked = [...providers.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    const topFamily = ranked[0]?.[0]
    const isConflict = !exact && ranked.length > 1 && (ranked[0]?.[1] ?? 0) - (ranked[1]?.[1] ?? 0) < 50
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
        const result = providerResult({
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
        return result
      }
    }

    if (isConflict) {
      return MailboxDiscoveryResultSchema.parse({
        authentication: { available: true, strategy: 'manual', unavailableReason: null },
        configurationConfidence: 0.45,
        credentialDestinationTrust: 0,
        domain: parsed.domain,
        email: parsed.email,
        evidence: findings,
        fallbackConnectors: [],
        preferredConnector: recommendation('manual', true),
        provider: 'unknown',
        ui: { providerIcon: 'generic', providerName: 'Email services', requiresAdvancedSettings: false, requiresManualSettings: true, requiresProviderConfirmation: true },
      })
    }

    const trustedCandidate = candidates.find((candidate) => candidate.trusted)
    if (hasTrustedJmap && capabilities.jmap) {
      return MailboxDiscoveryResultSchema.parse({
        authentication: { available: capabilities.jmap, strategy: 'password', unavailableReason: capabilities.jmap ? null : 'not_supported' },
        configurationConfidence: 0.9,
        credentialDestinationTrust: 1,
        domain: parsed.domain,
        email: parsed.email,
        evidence: findings,
        fallbackConnectors: trustedCandidate ? [recommendation('imap_smtp', true)] : [recommendation('manual', true)],
        preferredConnector: recommendation('jmap', capabilities.jmap),
        provider: 'generic',
        ...(trustedCandidate ? { trustedImapSmtp: trustedCandidate.config } : {}),
        ui: { providerIcon: 'generic', providerName: 'Email provider', requiresAdvancedSettings: false, requiresManualSettings: !trustedCandidate, requiresProviderConfirmation: false },
      })
    }
    if (trustedCandidate) {
      return MailboxDiscoveryResultSchema.parse({
        authentication: { available: true, strategy: 'password', unavailableReason: null },
        configurationConfidence: trustedCandidate.source === 'autoconfig' ? 0.9 : 0.85,
        credentialDestinationTrust: 0.95,
        domain: parsed.domain,
        email: parsed.email,
        evidence: findings,
        fallbackConnectors: [recommendation('manual', true)],
        preferredConnector: recommendation('imap_smtp', true),
        provider: 'generic',
        trustedImapSmtp: trustedCandidate.config,
        ui: { providerIcon: 'generic', providerName: 'Email provider', requiresAdvancedSettings: false, requiresManualSettings: false, requiresProviderConfirmation: false },
      })
    }
    const externalSrv = candidates.find((candidate) => !candidate.trusted)
    return MailboxDiscoveryResultSchema.parse({
      authentication: { available: true, strategy: 'manual', unavailableReason: null },
      configurationConfidence: externalSrv ? 0.45 : 0,
      credentialDestinationTrust: 0,
      domain: parsed.domain,
      email: parsed.email,
      evidence: findings,
      fallbackConnectors: [],
      preferredConnector: recommendation('manual', true),
      provider: 'generic',
      ui: {
        providerIcon: 'generic',
        providerName: 'Email provider',
        requiresAdvancedSettings: false,
        requiresManualSettings: true,
        requiresProviderConfirmation: Boolean(externalSrv),
      },
    })
  }
}
