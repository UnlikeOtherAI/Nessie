import { ImapError, ImapSession } from './imap.js'
import { MailDialError } from './dial.js'
import { SmtpError, closeSmtpSession, openSmtpSession } from './smtp.js'
import { mailboxDiscoveryHostname, parseMailboxDiscoveryAddress } from './mailbox-discovery-address.js'
import { MAILBOX_PROBE_BUDGET_MS, probeMailboxLeg } from './mailbox-probe.js'
import { DEFAULT_FOLDER } from './mailbox-client.js'
import type { DialOptions, MailEndpoint, MailSecurity } from './dial.js'
import type { MailboxProbeOutcome, MailboxProbeProtocol } from './mailbox-probe.js'

/**
 * Finding the endpoints, with the credential in hand.
 *
 * `mailbox-probe.ts` answers "may a password be typed towards this?" before one
 * exists. This module is the step after: the person has now given us a
 * password, and the question is which of a small set of standard endpoints
 * actually accepts it. That is why the two are separate files rather than one
 * with a flag — the probe's whole guarantee is that it *cannot* carry a secret,
 * and a module that logs in cannot make that promise.
 *
 * The rule that keeps both honest: **a hostname the person did not type is
 * probed credential-free before it is ever logged into.** Guessing a port on a
 * host somebody named is safe — the TLS certificate is pinned to that hostname
 * on every dial, so a wrong port cannot hand the password to a stranger.
 * Guessing the *hostname* is the part that could, so a derived candidate must
 * first prove, without a credential on the wire, that it speaks the protocol
 * over a session we can verify. Only `confirmed` earns a login.
 *
 * Everything here is bounded: a fixed port matrix, at most three hostnames per
 * leg, the registered ports the probe already allows, and one deadline over the
 * whole resolution.
 */

export type MailboxLegProtocol = MailboxProbeProtocol

/** What a person supplied for one leg. Any absent part is ours to resolve. */
export type MailboxLegRequest = {
  host?: string | null
  port?: number | null
  security?: MailSecurity | null
}

export type MailboxResolveRequest = {
  address: string
  username: string
  password: string
  /**
   * One hostname standing in for both legs — the single "mail server" a person
   * types when they know that much and no more. A leg's own `host` wins.
   */
  server?: string | null
  imap?: MailboxLegRequest | null
  smtp?: MailboxLegRequest | null
}

/**
 * Why a leg produced no endpoint. Ordered by how much it tells the person:
 * a rejected credential is an answer from the right server, `insecure` means we
 * found it and will not talk to it, and `unreachable` means nothing answered.
 */
export type MailboxLegFailure =
  | 'credential_rejected'
  | 'insecure'
  | 'unreachable'
  | 'no_candidate'

export type MailboxLegResolution =
  | { endpoint: MailEndpoint; ok: true }
  | { failure: MailboxLegFailure; ok: false; tried: MailEndpoint[] }

export type MailboxResolution = {
  imap: MailboxLegResolution
  smtp: MailboxLegResolution
}

/**
 * Test seams. The dialer refuses loopback on purpose, so the candidate
 * ordering, the probe gate and the short circuits cannot be exercised against a
 * scripted local server — they are driven through these instead, exactly as
 * `DialOptions.resolveHost` drives the dial's own refusals.
 *
 * Note what `attempt` is *not* given: the credential. The real implementation
 * closes over it, so a substituted seam receives an endpoint and nothing else.
 * A seam that could be handed a password would be a way to route one somewhere
 * the gate below never approved.
 */
export type MailboxResolveDeps = {
  probe?: (
    protocol: MailboxLegProtocol,
    endpoint: MailEndpoint,
    deadline: number,
  ) => Promise<MailboxProbeOutcome>
  /** Resolves when the endpoint accepted the credential; throws as clients do. */
  attempt?: (protocol: MailboxLegProtocol, endpoint: MailEndpoint) => Promise<void>
}

export type MailboxResolveOptions = DialOptions & MailboxResolveDeps & {
  /** Whole-resolution budget. Both legs and every candidate share it. */
  deadline?: number
  maxBufferBytes?: number
}

/** The candidate ports, best first. Confined to what the probe already allows. */
const PORT_MATRIX: Record<MailboxLegProtocol, readonly MailEndpoint['port'][]> = {
  imap: [993, 143],
  smtp: [587, 465, 25],
}

/**
 * The transport each registered port is defined to carry. A person who gives a
 * port and no security has still said enough: there is exactly one secure way
 * to speak on each of these, and offering them a dropdown to get it wrong is
 * not a choice, it is a trap.
 */
const SECURITY_BY_PORT: Record<number, MailSecurity> = {
  25: 'starttls',
  143: 'starttls',
  465: 'tls',
  587: 'starttls',
  993: 'tls',
}

/** Where each leg conventionally lives, best guess first. */
const HOST_PREFIXES: Record<MailboxLegProtocol, readonly string[]> = {
  imap: ['imap.', 'mail.', ''],
  smtp: ['smtp.', 'mail.', ''],
}

/** A leg's whole resolution budget when the caller sets none. */
export const MAILBOX_RESOLVE_BUDGET_MS = 25_000

type HostCandidate = {
  host: string
  /**
   * The person named this host. It decides whether a credential may be dialled
   * straight at it, so it is carried per candidate rather than inferred later.
   */
  typed: boolean
}

const hostCandidates = (
  protocol: MailboxLegProtocol,
  request: MailboxResolveRequest,
): HostCandidate[] => {
  const typed = request[protocol]?.host?.trim() || request.server?.trim() || ''
  if (typed) {
    const host = mailboxDiscoveryHostname(typed)
    return host ? [{ host, typed: true }] : []
  }
  let domain: string
  try {
    domain = parseMailboxDiscoveryAddress(request.address).domain
  } catch {
    return []
  }
  const candidates: HostCandidate[] = []
  for (const prefix of HOST_PREFIXES[protocol]) {
    const host = mailboxDiscoveryHostname(`${prefix}${domain}`)
    if (host && !candidates.some((entry) => entry.host === host)) {
      candidates.push({ host, typed: false })
    }
  }
  return candidates
}

/**
 * The transports to try on one host. An explicit port narrows this to that
 * port; an explicit security narrows it further. Nothing here widens what the
 * person asked for — a stated setting is an instruction, not a hint.
 */
const portCandidates = (
  protocol: MailboxLegProtocol,
  leg: MailboxLegRequest | null | undefined,
): MailEndpoint[] => {
  const ports = leg?.port ? [leg.port] : [...PORT_MATRIX[protocol]]
  const endpoints: MailEndpoint[] = []
  for (const port of ports) {
    const security = leg?.security ?? SECURITY_BY_PORT[port]
    // A port outside the registered set and with no stated transport is not
    // something to guess a security for: STARTTLS is the safe reading, and the
    // dial refuses anything that will not upgrade.
    endpoints.push({ host: '', port, security: security ?? 'starttls' })
  }
  return endpoints
}

/** The most useful thing we learned, by the ordering on `MailboxLegFailure`. */
const RANKED_FAILURES: readonly MailboxLegFailure[] = [
  'credential_rejected',
  'insecure',
  'unreachable',
  'no_candidate',
]

const worstOf = (a: MailboxLegFailure, b: MailboxLegFailure): MailboxLegFailure =>
  RANKED_FAILURES.indexOf(a) <= RANKED_FAILURES.indexOf(b) ? a : b

/**
 * A failed login attempt, classified the way the protocol layers report it
 * rather than by reading a message. Both of them raise `kind: 'auth'` for a
 * refused credential and nothing else does, so everything below that check is
 * honestly "we could not tell" — which is what `unreachable` means here, and
 * why an unclassified failure keeps the sweep going instead of ending it.
 * `certificate` is the same answer the probe gives: we reached it, and we will
 * not trust the session.
 */
const attemptFailure = (error: unknown): MailboxLegFailure => {
  if ((error instanceof ImapError || error instanceof SmtpError) && error.kind === 'auth') {
    return 'credential_rejected'
  }
  if (error instanceof MailDialError && error.kind === 'certificate') return 'insecure'
  return 'unreachable'
}

/**
 * Log in and prove the leg does its job: IMAP must select the inbox, SMTP must
 * complete an authenticated handshake. This is the same two-leg check the
 * connection test has always made — kept here so a resolved endpoint arrives
 * already verified rather than being dialled a second time to confirm it.
 */
const login = async (
  protocol: MailboxLegProtocol,
  endpoint: MailEndpoint,
  request: MailboxResolveRequest,
  options: MailboxResolveOptions,
): Promise<void> => {
  const credentials = { password: request.password, username: request.username }
  if (protocol === 'imap') {
    const session = await ImapSession.open(endpoint, credentials, options)
    try {
      await session.selectFolder(DEFAULT_FOLDER)
    } finally {
      session.close()
    }
    return
  }
  const session = await openSmtpSession(endpoint, credentials, {
    ...options,
    clientName: request.address.split('@')[1] ?? 'localhost',
  })
  closeSmtpSession(session)
}

const resolveLeg = async (
  protocol: MailboxLegProtocol,
  request: MailboxResolveRequest,
  options: MailboxResolveOptions,
  deadline: number,
): Promise<MailboxLegResolution> => {
  const hosts = hostCandidates(protocol, request)
  const ports = portCandidates(protocol, request[protocol])
  if (hosts.length === 0 || ports.length === 0) {
    return { failure: 'no_candidate', ok: false, tried: [] }
  }

  const probe = options.probe
    ?? ((leg, endpoint, deadlineMs) =>
      probeMailboxLeg(leg, endpoint, { clientName: endpoint.host, deadline: deadlineMs }))
  const attempt = options.attempt
    ?? ((leg, endpoint) => login(leg, endpoint, request, options))

  const tried: MailEndpoint[] = []
  let failure: MailboxLegFailure = 'unreachable'
  for (const host of hosts) {
    for (const candidate of ports) {
      if (Date.now() >= deadline) return { failure, ok: false, tried }
      const endpoint: MailEndpoint = { ...candidate, host: host.host }
      tried.push(endpoint)

      // The gate. A hostname we derived has to prove itself without a secret on
      // the wire before one goes there; a hostname the person typed is theirs
      // to name and needs no permission from us.
      if (!host.typed) {
        const outcome = await probe(
          protocol,
          endpoint,
          Math.min(deadline, Date.now() + MAILBOX_PROBE_BUDGET_MS),
        )
        if (outcome === 'insecure') failure = worstOf(failure, 'insecure')
        if (outcome !== 'confirmed') continue
      }

      try {
        await attempt(protocol, endpoint)
        return { endpoint, ok: true }
      } catch (error) {
        const attempt = attemptFailure(error)
        // The server verified its identity and refused this password. Every
        // other port on it would refuse the same one: trying them is useless,
        // and a password replayed across a host's ports is exactly the shape
        // of the traffic a mail server blocks an address for.
        if (attempt === 'credential_rejected') {
          return { failure: attempt, ok: false, tried }
        }
        failure = worstOf(failure, attempt)
      }
    }
  }
  return { failure, ok: false, tried }
}

/**
 * Resolve both legs.
 *
 * IMAP first and then SMTP, sequentially rather than in parallel: the legs
 * usually live on the same host, and a mailbox whose access leg rejects the
 * password has told us everything the send leg would.
 */
export const resolveMailboxEndpoints = async (
  request: MailboxResolveRequest,
  options: MailboxResolveOptions,
): Promise<MailboxResolution> => {
  const deadline = options.deadline ?? Date.now() + MAILBOX_RESOLVE_BUDGET_MS
  const imap = await resolveLeg('imap', request, options, deadline)
  if (!imap.ok && imap.failure === 'credential_rejected') {
    return { imap, smtp: { failure: 'credential_rejected', ok: false, tried: [] } }
  }
  const smtp = await resolveLeg('smtp', request, options, deadline)
  return { imap, smtp }
}
