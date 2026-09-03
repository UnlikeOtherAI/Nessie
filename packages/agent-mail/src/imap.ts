import type { Socket } from 'node:net'

import { dialPlain, dialTls, upgradeToTls, type DialOptions, type MailEndpoint } from './dial.js'
import { MailWire } from './wire.js'

/**
 * A minimal IMAP client — enough to select a folder, search it, and fetch whole
 * messages. Everything above that (parsing, threading, sanitising) is already
 * owned by `mime.ts`, so this layer deliberately does not model ENVELOPE or
 * BODYSTRUCTURE: it asks for the raw RFC822 bytes and hands them to the one
 * parser this package already has.
 *
 * **Every caller-supplied value is written as a counted literal.** IMAP has no
 * escaping that survives a hostile string, and a folder name or search term
 * reaching here came from a model reading somebody's mail — the classic
 * indirect-injection path. A literal is length-prefixed, so no byte inside it
 * can end the command, whatever it contains. That is a structural property, not
 * a validation anybody has to remember, which is why nothing here quotes.
 */

export class ImapError extends Error {
  constructor(
    message: string,
    readonly kind: 'auth' | 'protocol' | 'not_found',
  ) {
    super(message)
    this.name = 'ImapError'
  }
}

/** A command part: raw protocol text, or a value that must not be trusted. */
export type ImapPart = string | { literal: string }

type ImapResponse = {
  /** The logical line with literals elided, e.g. `* 12 FETCH (UID 45 BODY[] )`. */
  text: string
  /** Literal payloads in the order they appeared. */
  literals: Buffer[]
}

const LITERAL_HEADER = /\{(\d+)\}$/

export class ImapSession {
  private tagCounter = 0

  private constructor(private wire: MailWire) {}

  static async open(
    endpoint: MailEndpoint,
    credentials: { username: string; password: string },
    options: DialOptions & { maxBufferBytes?: number },
  ): Promise<ImapSession> {
    return ImapSession.handshake(
      endpoint.security === 'tls'
        ? await dialTls(endpoint, options)
        : await dialPlain(endpoint, options),
      endpoint,
      credentials,
      options,
    )
  }

  /**
   * The protocol half, on an already-open socket. Split from the dial so the
   * conversation can be exercised against a fake server without a seam that
   * would let a caller skip the address vetting — `dialPlain`/`dialTls` stay
   * the only way a connection is made.
   */
  static async handshake(
    connected: Socket,
    endpoint: MailEndpoint,
    credentials: { username: string; password: string },
    options: DialOptions & { maxBufferBytes?: number },
  ): Promise<ImapSession> {
    const wireOptions = {
      maxBufferBytes: options.maxBufferBytes ?? 32 * 1024 * 1024,
      timeoutMs: options.timeoutMs,
    }
    let socket: Socket = connected
    let wire = new MailWire(socket, wireOptions)
    const session = new ImapSession(wire)

    try {
      const greeting = await wire.readLine()
      if (!/^\*\s+(OK|PREAUTH)\b/i.test(greeting)) {
        throw new ImapError('The mail server refused the connection.', 'protocol')
      }

      if (endpoint.security === 'starttls') {
        const capabilities = await session.run(['CAPABILITY'])
        if (!/\bSTARTTLS\b/i.test(capabilities.text)) {
          throw new ImapError(
            'The mail server does not offer STARTTLS, so the password would be sent in the clear.',
            'protocol',
          )
        }
        await session.run(['STARTTLS'])
        socket = await upgradeToTls(socket, endpoint.host, options)
        wire = MailWire.reattach(wire, socket)
        session.wire = wire
      }

      try {
        await session.run([
          'LOGIN ',
          { literal: credentials.username },
          ' ',
          { literal: credentials.password },
        ])
      } catch (error) {
        // Only the server's own refusal is an authentication failure. A timeout
        // or a dropped socket is not, and calling it one would put a connection
        // into `needs_reauthorization` that nothing about reauthorizing fixes.
        if (error instanceof ImapError && error.kind === 'protocol') {
          throw new ImapError('The mail server rejected the username or password.', 'auth')
        }
        throw error
      }
      return session
    } catch (error) {
      wire.close()
      throw error
    }
  }

  /**
   * One logical response: a line, plus any literals it announced. A literal's
   * `{n}` is always the last thing on its line, so the read is unambiguous.
   */
  private async readResponse(): Promise<ImapResponse> {
    let text = ''
    const literals: Buffer[] = []
    for (;;) {
      const line = await this.wire.readLine()
      const match = LITERAL_HEADER.exec(line)
      if (!match) return { literals, text: text + line }
      text += line.slice(0, match.index)
      literals.push(await this.wire.readExact(Number(match[1])))
    }
  }

  /** Write one command, resolving synchronizing literals as the server asks. */
  private async write(tag: string, parts: ImapPart[]): Promise<void> {
    let pending = `${tag} `
    for (const part of parts) {
      if (typeof part === 'string') {
        pending += part
        continue
      }
      const bytes = Buffer.from(part.literal, 'utf8')
      this.wire.write(`${pending}{${bytes.byteLength}}\r\n`)
      const continuation = await this.wire.readLine()
      if (!continuation.startsWith('+')) {
        throw new ImapError('The mail server refused a command argument.', 'protocol')
      }
      this.wire.write(bytes)
      pending = ''
    }
    this.wire.write(`${pending}\r\n`)
  }

  /** Run a command and collect its untagged responses up to the tagged result. */
  async run(parts: ImapPart[]): Promise<{ text: string; untagged: ImapResponse[] }> {
    this.tagCounter += 1
    const tag = `n${this.tagCounter}`
    await this.write(tag, parts)

    const untagged: ImapResponse[] = []
    for (;;) {
      const response = await this.readResponse()
      if (response.text.startsWith(`${tag} `)) {
        const status = response.text.slice(tag.length + 1)
        if (!/^OK\b/i.test(status)) {
          throw new ImapError(`The mail server refused the request: ${status}`, 'protocol')
        }
        return { text: status, untagged }
      }
      untagged.push(response)
    }
  }

  async selectFolder(folder: string): Promise<void> {
    try {
      await this.run(['SELECT ', { literal: folder }])
    } catch (error) {
      if (error instanceof ImapError && error.kind === 'protocol') {
        throw new ImapError(`There is no folder called “${folder}” in this mailbox.`, 'not_found')
      }
      throw error
    }
  }

  /** `UID SEARCH` with every term as a literal. Returns newest UIDs first. */
  async searchUids(criteria: ImapPart[]): Promise<number[]> {
    // RFC 3501 defaults SEARCH to US-ASCII, so a term in any other alphabet
    // needs the charset declared or the server matches nothing. It is announced
    // only when actually needed: a server without UTF-8 support answers
    // BADCHARSET, and an ASCII-only search should not have to care.
    const needsCharset = criteria.some(
      (part) => typeof part !== 'string' && /[^\x00-\x7F]/.test(part.literal),
    )
    const result = await this.run([
      `UID SEARCH ${needsCharset ? 'CHARSET UTF-8 ' : ''}`,
      ...criteria,
    ])
    const line = result.untagged.find((response) => /^\*\s+SEARCH\b/i.test(response.text))
    if (!line) return []
    const uids = line.text
      .replace(/^\*\s+SEARCH\s*/i, '')
      .trim()
      .split(/\s+/)
      .map((value) => Number(value))
      .filter((value) => Number.isInteger(value) && value > 0)
    return uids.sort((a, b) => b - a)
  }

  /**
   * Fetch whole messages by UID. `BODY.PEEK[]` rather than `BODY[]`: reading a
   * mailbox must not mark somebody's mail as read behind their back.
   */
  async fetchMessages(
    uids: number[],
    what: 'full' | 'headers',
  ): Promise<{ uid: number; raw: Buffer }[]> {
    if (uids.length === 0) return []
    const item =
      what === 'full'
        ? 'BODY.PEEK[]'
        : 'BODY.PEEK[HEADER.FIELDS (FROM TO CC SUBJECT DATE MESSAGE-ID IN-REPLY-TO)]'
    // UIDs are integers we produced from SEARCH output, never model text.
    const set = uids.join(',')
    const result = await this.run([`UID FETCH ${set} (UID ${item})`])

    const messages: { uid: number; raw: Buffer }[] = []
    for (const response of result.untagged) {
      if (!/\bFETCH\b/i.test(response.text)) continue
      const uidMatch = /\bUID\s+(\d+)/i.exec(response.text)
      const raw = response.literals[0]
      if (!uidMatch || !raw) continue
      messages.push({ raw, uid: Number(uidMatch[1]) })
    }
    return messages
  }

  close(): void {
    try {
      this.wire.write('nX LOGOUT\r\n')
    } catch {
      // Closing is best-effort; the read side is already finished with.
    }
    this.wire.close()
  }
}
