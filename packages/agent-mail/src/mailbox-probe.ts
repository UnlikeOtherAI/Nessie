import type { Socket } from 'node:net'

import type { TrustedMailboxImapSmtpConfig } from '@nessie/schemas'

import {
  MailDialError,
  dialPlain,
  dialTls,
  upgradeToTls,
  type DialOptions,
  type MailEndpoint,
} from './dial.js'
import { mailboxDiscoveryHostname } from './mailbox-discovery-address.js'
import { MailWire } from './wire.js'

/**
 * An unauthenticated capability probe: does this endpoint pair actually speak
 * IMAP and SMTP over a TLS session we can verify?
 *
 * **This module cannot send a credential, and that is the point.** There is no
 * username or password parameter anywhere in it — not on the exported probe,
 * not on the conversation halves, not on an options object. A discovered
 * configuration is the *destination* a person's mail password would be typed
 * into, so the check that decides whether that screen may open must be
 * structurally incapable of typing it there first. A parameter that could carry
 * a secret is the whole risk; refusing to have one removes it rather than
 * documenting it.
 *
 * That is also why the three-command conversation is written here instead of
 * calling `ImapSession.open` / `openSmtpSession`: both take credentials by
 * design, because their job is to log in. Reusing them would mean handing this
 * module a credential parameter it must promise not to use. **Do not
 * "simplify" this back into those clients.** The dial, the TLS pinning and the
 * framing — the parts that must never be re-implemented — are already shared:
 * `dialTls`/`dialPlain`/`upgradeToTls` re-resolve and re-vet the host on every
 * dial and check the certificate against the configured hostname, and `MailWire`
 * does the bounded line reading.
 *
 * The outcome is a four-value union and never an error string, hostname or
 * certificate detail: it shapes a result that crosses to a browser.
 */

export type MailboxProbeOutcome = 'confirmed' | 'insecure' | 'unreachable' | 'skipped'

export type MailboxProbeOptions = {
  /** Announced in EHLO; the mail domain being set up, never an identifier. */
  clientName: string
  /**
   * Absolute time this leg must be finished by. It belongs to the conversation
   * rather than the caller because `MailWire`'s timeout is *per read* and both
   * conversations loop — untagged IMAP lines, `250-` SMTP continuations — so a
   * server that answers slowly but never stops would reset the clock forever
   * and hold a discovery request open. Defaults to the module budget.
   */
  deadline?: number
}

export type MailboxCapabilityProbe = (
  config: TrustedMailboxImapSmtpConfig,
  options: MailboxProbeOptions,
) => Promise<MailboxProbeOutcome>

/**
 * Both legs together. Discovery answers a waiting form inside its own budget,
 * so the probe holds a short one of its own rather than inheriting the caller's.
 */
export const MAILBOX_PROBE_BUDGET_MS = 2_000

/**
 * The registered submission and access ports, and nothing else. A discovered
 * document can name any port it likes, and this module opens sockets: an
 * unexpected port is `skipped` without a dial rather than turned into a
 * port scan somebody could aim through us.
 */
const IMAP_PROBE_PORTS = new Set([143, 993])
const SMTP_PROBE_PORTS = new Set([25, 465, 587])

/** A greeting and a capability list; nothing here reads a mailbox. */
const PROBE_MAX_BUFFER_BYTES = 64 * 1024

/**
 * A TLS session we cannot verify is not a transport problem to retry — it is
 * the answer. Everything else on the wire is "we could not tell".
 */
const dialOutcome = (error: unknown): MailboxProbeOutcome =>
  error instanceof MailDialError && error.kind === 'certificate' ? 'insecure' : 'unreachable'

const wireFor = (socket: Socket, options: DialOptions): MailWire =>
  new MailWire(socket, { maxBufferBytes: PROBE_MAX_BUFFER_BYTES, timeoutMs: options.timeoutMs })

/**
 * Hold a conversation to an absolute deadline, destroying the socket when it
 * expires so the exchange cannot outlive the answer we gave about it.
 */
const withinDeadline = async (
  socket: Socket,
  deadline: number | undefined,
  conversation: () => Promise<MailboxProbeOutcome>,
): Promise<MailboxProbeOutcome> => {
  const remaining = (deadline ?? Date.now() + MAILBOX_PROBE_BUDGET_MS) - Date.now()
  if (remaining <= 0) {
    socket.destroy()
    return 'unreachable'
  }
  let expiry: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      conversation(),
      new Promise<MailboxProbeOutcome>((resolve) => {
        expiry = setTimeout(() => {
          socket.destroy()
          resolve('unreachable')
        }, remaining)
      }),
    ])
  } finally {
    if (expiry) clearTimeout(expiry)
  }
}

/** One tagged IMAP command, with the untagged lines it produced. */
const imapCommand = async (
  wire: MailWire,
  tag: string,
  command: string,
): Promise<{ ok: boolean; untagged: string }> => {
  wire.write(`${tag} ${command}\r\n`)
  let untagged = ''
  for (;;) {
    const line = await wire.readLine()
    if (line.startsWith(`${tag} `)) return { ok: /^OK\b/i.test(line.slice(tag.length + 1)), untagged }
    untagged += `${line}\n`
  }
}

/**
 * The IMAP half on an already-open socket.
 *
 * Split from the dial exactly as `ImapSession.handshake` is, and for the same
 * reason: the conversation can then be exercised against a fake server without
 * a seam that would let a caller skip the address vetting — `dialPlain` and
 * `dialTls` stay the only way this module makes a connection.
 */
export const runImapCapabilityProbe = async (
  connected: Socket,
  endpoint: MailEndpoint,
  options: DialOptions & Partial<MailboxProbeOptions>,
): Promise<MailboxProbeOutcome> =>
  withinDeadline(connected, options.deadline, () => imapConversation(connected, endpoint, options))

const imapConversation = async (
  connected: Socket,
  endpoint: MailEndpoint,
  options: DialOptions,
): Promise<MailboxProbeOutcome> => {
  let socket = connected
  let wire = wireFor(socket, options)
  try {
    const greeting = await wire.readLine()
    if (!/^\*\s+(OK|PREAUTH)\b/i.test(greeting)) return 'unreachable'
    let capabilities = await imapCommand(wire, 'p1', 'CAPABILITY')
    if (!capabilities.ok) return 'unreachable'
    if (endpoint.security === 'starttls') {
      // A server that will not upgrade is a downgrade, not a fallback: the
      // password screen this authorises would send the secret in the clear.
      if (!/\bSTARTTLS\b/i.test(capabilities.untagged)) return 'insecure'
      if (!(await imapCommand(wire, 'p2', 'STARTTLS')).ok) return 'insecure'
      try {
        socket = await upgradeToTls(socket, endpoint.host, options)
        // `reattach` refuses buffered plaintext carried across the boundary —
        // the signature of an injection attempt. Both failures happen after a
        // successful connect, so neither is "we could not reach it": we reached
        // it and could not get a verified session, which is the answer itself.
        wire = MailWire.reattach(wire, socket)
      } catch {
        return 'insecure'
      }
      capabilities = await imapCommand(wire, 'p3', 'CAPABILITY')
      if (!capabilities.ok) return 'unreachable'
    }
    // The answer is already known, so the goodbye is best-effort — but it is
    // awaited rather than fired at a socket we are about to destroy, or the
    // bytes never leave and the server is left holding a connection.
    try {
      await imapCommand(wire, 'p4', 'LOGOUT')
    } catch {
      // A server that hangs up on LOGOUT has still proved it speaks IMAP.
    }
    return 'confirmed'
  } catch {
    return 'unreachable'
  } finally {
    wire.close()
  }
}

type SmtpProbeReply = { code: number; lines: string[] }

/** One SMTP reply, continuation lines included. Code 0 means unreadable. */
const smtpReply = async (wire: MailWire): Promise<SmtpProbeReply> => {
  const lines: string[] = []
  for (;;) {
    const line = await wire.readLine()
    const code = Number(line.slice(0, 3))
    if (!Number.isInteger(code)) return { code: 0, lines }
    lines.push(line.slice(4))
    // `250-` continues the reply; `250 ` ends it.
    if (line[3] !== '-') return { code, lines }
  }
}

/** The SMTP half on an already-open socket; split from the dial as above. */
export const runSmtpCapabilityProbe = async (
  connected: Socket,
  endpoint: MailEndpoint,
  options: DialOptions & MailboxProbeOptions,
): Promise<MailboxProbeOutcome> =>
  withinDeadline(connected, options.deadline, () => smtpConversation(connected, endpoint, options))

const smtpConversation = async (
  connected: Socket,
  endpoint: MailEndpoint,
  options: DialOptions & MailboxProbeOptions,
): Promise<MailboxProbeOutcome> => {
  let socket = connected
  let wire = wireFor(socket, options)
  // Discovery only ever passes a canonicalised domain, but this half is
  // exported: a caller with a CRLF in `clientName` would otherwise be writing
  // its own SMTP commands on the plaintext leg. One assertion closes that for
  // every future caller instead of relying on each to have been careful.
  const clientName = mailboxDiscoveryHostname(options.clientName)
  if (!clientName) return 'skipped'
  const greet = async (): Promise<SmtpProbeReply> => {
    wire.write(`EHLO ${clientName}\r\n`)
    return smtpReply(wire)
  }
  try {
    if ((await smtpReply(wire)).code !== 220) return 'unreachable'
    let capabilities = await greet()
    if (capabilities.code !== 250) return 'unreachable'
    if (endpoint.security === 'starttls') {
      if (!capabilities.lines.some((line) => /^starttls\b/i.test(line))) return 'insecure'
      wire.write('STARTTLS\r\n')
      if ((await smtpReply(wire)).code !== 220) return 'insecure'
      try {
        socket = await upgradeToTls(socket, endpoint.host, options)
        // Same reasoning as the IMAP leg: past a successful connect, a failed
        // upgrade or refused reattach is an insecure destination, not an
        // unreachable one.
        wire = MailWire.reattach(wire, socket)
      } catch {
        return 'insecure'
      }
      // Capabilities announced before TLS are unauthenticated and discarded.
      capabilities = await greet()
      if (capabilities.code !== 250) return 'unreachable'
    }
    // Awaited for the same reason as IMAP's LOGOUT: an unflushed goodbye is no
    // goodbye at all.
    try {
      wire.write('QUIT\r\n')
      await smtpReply(wire)
    } catch {
      // A server that hangs up on QUIT has still proved it speaks SMTP.
    }
    return 'confirmed'
  } catch {
    return 'unreachable'
  } finally {
    wire.close()
  }
}

const probeLeg = async (
  endpoint: MailEndpoint,
  deadline: number,
  options: MailboxProbeOptions,
  converse: (
    socket: Socket,
    endpoint: MailEndpoint,
    dialOptions: DialOptions & MailboxProbeOptions,
  ) => Promise<MailboxProbeOutcome>,
): Promise<MailboxProbeOutcome> => {
  const timeoutMs = deadline - Date.now()
  if (timeoutMs <= 0) return 'unreachable'
  const dialOptions = { ...options, timeoutMs }
  let socket: Socket
  try {
    socket = endpoint.security === 'tls'
      ? await dialTls(endpoint, dialOptions)
      : await dialPlain(endpoint, dialOptions)
  } catch (error) {
    return dialOutcome(error)
  }
  // The conversation enforces the deadline itself, so the budget covers the
  // whole leg — dial included — rather than each individual read.
  return converse(socket, endpoint, { ...dialOptions, deadline })
}

/**
 * Confirm a discovered configuration end to end. IMAP first: a pair whose
 * access leg does not answer is not worth a second dial.
 */
export const probeMailboxCapability: MailboxCapabilityProbe = async (config, options) => {
  if (!IMAP_PROBE_PORTS.has(config.imap.port) || !SMTP_PROBE_PORTS.has(config.smtp.port)) {
    return 'skipped'
  }
  const deadline = Date.now() + MAILBOX_PROBE_BUDGET_MS
  const imap = await probeLeg(config.imap, deadline, options, runImapCapabilityProbe)
  if (imap !== 'confirmed') return imap
  return probeLeg(config.smtp, deadline, options, runSmtpCapabilityProbe)
}
