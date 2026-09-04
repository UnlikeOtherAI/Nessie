import type { Socket } from 'node:net'

import { normalizeAddress } from './address.js'
import { dialPlain, dialTls, upgradeToTls, type DialOptions, type MailEndpoint } from './dial.js'
import { MailWire } from './wire.js'

/**
 * A minimal SMTP submission client — EHLO, STARTTLS, AUTH, one message.
 *
 * Hand-written rather than delegated to a mail library for one reason that
 * matters: this connection must be dialled by a just-vetted IP with SNI pinned
 * to the configured hostname (see `dial.ts`), and a library that owns its own
 * socket cannot be given that. Everything else here is deliberately small —
 * submission to a configured server, no relaying, no queueing, no retries.
 *
 * The MIME itself is built by `buildOutboundMime`, the same builder the hosted
 * SES mailbox uses. Two message builders would drift.
 */

export class SmtpError extends Error {
  constructor(
    message: string,
    readonly code: number | null,
    /** Auth failures are the connection's problem to fix, not a transient. */
    readonly kind: 'auth' | 'protocol' | 'recipient' | 'transient',
  ) {
    super(message)
    this.name = 'SmtpError'
  }
}

type SmtpReply = { code: number; lines: string[] }

const readReply = async (wire: MailWire): Promise<SmtpReply> => {
  const lines: string[] = []
  for (;;) {
    const line = await wire.readLine()
    const code = Number(line.slice(0, 3))
    if (!Number.isInteger(code)) {
      throw new SmtpError('The mail server sent a reply we could not read.', null, 'protocol')
    }
    lines.push(line.slice(4))
    // `250-` continues the reply; `250 ` ends it.
    if (line[3] !== '-') return { code, lines }
  }
}

const expect = async (wire: MailWire, ok: (code: number) => boolean, what: string) => {
  const reply = await readReply(wire)
  if (!ok(reply.code)) {
    const kind = reply.code >= 500 ? 'protocol' : 'transient'
    throw new SmtpError(`${what} (${reply.code} ${reply.lines[0] ?? ''})`.trim(), reply.code, kind)
  }
  return reply
}

const command = async (
  wire: MailWire,
  line: string,
  ok: (code: number) => boolean,
  what: string,
): Promise<SmtpReply> => {
  wire.write(`${line}\r\n`)
  return expect(wire, ok, what)
}

const authMechanisms = (reply: SmtpReply): Set<string> => {
  const found = new Set<string>()
  for (const line of reply.lines) {
    if (!/^auth\b/i.test(line)) continue
    for (const mechanism of line.slice(4).trim().split(/\s+/)) {
      found.add(mechanism.toUpperCase())
    }
  }
  return found
}

const authenticate = async (
  wire: MailWire,
  capabilities: SmtpReply,
  credentials: { username: string; password: string },
): Promise<void> => {
  const mechanisms = authMechanisms(capabilities)
  const failure = (code: number | null, detail: string): SmtpError =>
    new SmtpError(
      `The mail server rejected the username or password (${detail}).`,
      code,
      'auth',
    )

  if (mechanisms.has('PLAIN') || mechanisms.size === 0) {
    const token = Buffer.from(
      `\0${credentials.username}\0${credentials.password}`,
      'utf8',
    ).toString('base64')
    wire.write(`AUTH PLAIN ${token}\r\n`)
    const reply = await readReply(wire)
    if (reply.code === 235) return
    if (!mechanisms.has('LOGIN')) throw failure(reply.code, reply.lines[0] ?? 'AUTH PLAIN')
  }

  if (mechanisms.has('LOGIN')) {
    wire.write('AUTH LOGIN\r\n')
    const prompt = await readReply(wire)
    if (prompt.code !== 334) throw failure(prompt.code, 'AUTH LOGIN')
    wire.write(`${Buffer.from(credentials.username, 'utf8').toString('base64')}\r\n`)
    const passwordPrompt = await readReply(wire)
    if (passwordPrompt.code !== 334) throw failure(passwordPrompt.code, 'username')
    wire.write(`${Buffer.from(credentials.password, 'utf8').toString('base64')}\r\n`)
    const result = await readReply(wire)
    if (result.code === 235) return
    throw failure(result.code, result.lines[0] ?? 'password')
  }

  throw new SmtpError(
    'The mail server offers no password authentication we can use.',
    null,
    'auth',
  )
}

/** SMTP ends the body with a lone `.`, so a body line of `.` must be escaped. */
const dotStuff = (mime: string): string =>
  mime.replace(/\r\n/g, '\n').split('\n').map((line) => (line.startsWith('.') ? `.${line}` : line))
    .join('\r\n')

const envelopeAddress = (label: string, value: string): string => {
  if (/[\r\n]/.test(value)) throw new SmtpError(`${label} cannot contain a line break.`, null, 'protocol')
  const normalized = normalizeAddress(value)
  if (!normalized || normalized !== value.trim().toLowerCase()) {
    throw new SmtpError(`${label} must be a bare email address.`, null, 'protocol')
  }
  return normalized
}

const clientName = (value: string): string => {
  if (!/^[a-z0-9.-]+$/i.test(value) || /[\r\n]/.test(value)) {
    throw new SmtpError('SMTP client name is invalid.', null, 'protocol')
  }
  return value
}

export type SmtpSession = {
  wire: MailWire
  capabilities: SmtpReply
  close(): void
}

/**
 * Connect, upgrade, and authenticate. Split from sending so the connection test
 * can prove exactly this much works without putting a message in anybody's
 * inbox.
 */
export const openSmtpSession = async (
  endpoint: MailEndpoint,
  credentials: { username: string; password: string },
  options: DialOptions & { clientName: string; maxBufferBytes?: number },
): Promise<SmtpSession> =>
  runSmtpHandshake(
    endpoint.security === 'tls'
      ? await dialTls(endpoint, options)
      : await dialPlain(endpoint, options),
    endpoint,
    credentials,
    options,
  )

/**
 * The protocol half, on an already-open socket.
 *
 * Split from the dial so the conversation can be exercised against a fake
 * server without a seam that would let a caller skip the address vetting —
 * `dialPlain`/`dialTls` stay the only way a connection is made, and their
 * refusals are tested on their own.
 */
export const runSmtpHandshake = async (
  connected: Socket,
  endpoint: MailEndpoint,
  credentials: { username: string; password: string },
  options: DialOptions & { clientName: string; maxBufferBytes?: number },
): Promise<SmtpSession> => {
  const greetingName = clientName(options.clientName)
  const wireOptions = {
    maxBufferBytes: options.maxBufferBytes ?? 1_000_000,
    timeoutMs: options.timeoutMs,
  }
  let socket: Socket = connected
  let wire = new MailWire(socket, wireOptions)

  try {
    await expect(wire, (code) => code === 220, 'The mail server refused the connection')
    let capabilities = await command(
      wire,
      `EHLO ${greetingName}`,
      (code) => code === 250,
      'The mail server rejected our greeting',
    )

    if (endpoint.security === 'starttls') {
      if (!capabilities.lines.some((line) => /^starttls\b/i.test(line))) {
        // Never silently continue in plaintext: the credential is next.
        throw new SmtpError(
          'The mail server does not offer STARTTLS, so the password would be sent in the clear.',
          null,
          'protocol',
        )
      }
      await command(wire, 'STARTTLS', (code) => code === 220, 'STARTTLS was refused')
      socket = await upgradeToTls(socket, endpoint.host, options)
      wire = MailWire.reattach(wire, socket)
      // Capabilities before TLS are unauthenticated and must be discarded.
      capabilities = await command(
        wire,
        `EHLO ${greetingName}`,
        (code) => code === 250,
        'The mail server rejected our greeting after TLS',
      )
    }

    await authenticate(wire, capabilities, credentials)
    return { capabilities, close: () => wire.close(), wire }
  } catch (error) {
    wire.close()
    throw error
  }
}

export const sendOverSmtp = async (
  session: SmtpSession,
  message: { from: string; recipients: string[]; mime: string },
): Promise<void> => {
  const { wire } = session
  const from = envelopeAddress('SMTP sender', message.from)
  const recipients = message.recipients.map((recipient) => envelopeAddress('SMTP recipient', recipient))
  await command(
    wire,
    `MAIL FROM:<${from}>`,
    (code) => code === 250,
    'The mail server rejected the sender',
  )
  for (const recipient of recipients) {
    wire.write(`RCPT TO:<${recipient}>\r\n`)
    const reply = await readReply(wire)
    if (reply.code !== 250 && reply.code !== 251) {
      throw new SmtpError(
        `The mail server rejected ${recipient} (${reply.code} ${reply.lines[0] ?? ''})`.trim(),
        reply.code,
        'recipient',
      )
    }
  }
  await command(wire, 'DATA', (code) => code === 354, 'The mail server refused the message body')
  wire.write(`${dotStuff(message.mime)}\r\n.\r\n`)
  await expect(wire, (code) => code === 250, 'The mail server did not accept the message')
}

export const closeSmtpSession = (session: SmtpSession): void => {
  try {
    session.wire.write('QUIT\r\n')
  } catch {
    // The message is already accepted; a failed QUIT changes nothing.
  }
  session.close()
}
