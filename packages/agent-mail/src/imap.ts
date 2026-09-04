import type { Socket } from 'node:net'

import { dialPlain, dialTls, upgradeToTls, type DialOptions, type MailEndpoint } from './dial.js'
import { MailWire } from './wire.js'
import { parseImapBodyStructure, type ImapBodyPart } from './imap-bodystructure.js'

/**
 * A minimal IMAP client — enough to select a folder, search it, inspect MIME
 * BODYSTRUCTURE, and fetch bounded text sections. Higher layers own header
 * parsing, threading, transfer decoding, and HTML sanitising.
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

  async selectFolder(folder: string): Promise<{ uidNext: number | null; uidValidity: number | null }> {
    try {
      const result = await this.run(['SELECT ', { literal: folder }])
      const uidValidityLine = result.untagged.find((response) => /\bUIDVALIDITY\s+\d+/i.test(response.text))
      const uidValidity = Number(/\bUIDVALIDITY\s+(\d+)/i.exec(uidValidityLine?.text ?? '')?.[1])
      const uidNextLine = result.untagged.find((response) => /\bUIDNEXT\s+\d+/i.test(response.text))
      const uidNext = Number(/\bUIDNEXT\s+(\d+)/i.exec(uidNextLine?.text ?? '')?.[1])
      return {
        uidNext: Number.isSafeInteger(uidNext) && uidNext > 0 ? uidNext : null,
        uidValidity: Number.isSafeInteger(uidValidity) && uidValidity > 0 ? uidValidity : null,
      }
    } catch (error) {
      if (error instanceof ImapError && error.kind === 'protocol') {
        throw new ImapError(`There is no folder called “${folder}” in this mailbox.`, 'not_found')
      }
      throw error
    }
  }

  /** Server capabilities are data, never guessed from a successful command. */
  async capabilities(): Promise<Set<string>> {
    const result = await this.run(['CAPABILITY'])
    const values = result.untagged
      .filter((response) => /^\*\s+CAPABILITY\b/i.test(response.text))
      .flatMap((response) => response.text.replace(/^\*\s+CAPABILITY\s*/i, '').split(/\s+/))
      .map((value) => value.toUpperCase())
    return new Set(values)
  }

  /**
   * RFC 5256 threading is optional. Callers may use it only after checking the
   * advertised algorithm; a failed probe must never turn into a guessed thread.
   */
  async threadReferencesUids(
    criteria: ImapPart[],
    charset: 'US-ASCII' | 'UTF-8' = 'US-ASCII',
  ): Promise<number[][]> {
    const result = await this.run([`UID THREAD REFERENCES ${charset} `, ...criteria])
    return result.untagged
      .filter((response) => /^\*\s+THREAD\b/i.test(response.text))
      .flatMap((response) => parseThreadReferenceSets(response.text))
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

  /** Resolve a structural Message-ID with a literal, never a quoted header value. */
  async searchMessageIdUids(messageId: string): Promise<number[]> {
    return this.searchUids(['HEADER MESSAGE-ID ', { literal: messageId }])
  }

  /** Fetch headers and MIME metadata only; message bodies use bounded sections. */
  async fetchMessages(
    uids: number[],
  ): Promise<{ uid: number; raw: Buffer; flags: string[]; bodyStructure: ImapBodyPart[] }[]> {
    if (uids.length === 0) return []
    const item = 'BODY.PEEK[HEADER.FIELDS (FROM TO CC SUBJECT DATE MESSAGE-ID IN-REPLY-TO REFERENCES)] BODYSTRUCTURE'
    // UIDs are integers we produced from SEARCH output, never model text.
    const set = uids.join(',')
    const result = await this.run([`UID FETCH ${set} (UID FLAGS ${item})`])

    const messages: { uid: number; raw: Buffer; flags: string[]; bodyStructure: ImapBodyPart[] }[] = []
    for (const response of result.untagged) {
      if (!/\bFETCH\b/i.test(response.text)) continue
      const uidMatch = /\bUID\s+(\d+)/i.exec(response.text)
      const raw = response.literals[0]
      if (!uidMatch || !raw) continue
      const flags = /\bFLAGS\s*\(([^)]*)\)/i.exec(response.text)?.[1]
        ?.split(/\s+/).filter(Boolean) ?? []
      messages.push({
        bodyStructure: parseImapBodyStructure(response.text),
        flags,
        raw,
        uid: Number(uidMatch[1]),
      })
    }
    return messages
  }

  /** Fetch metadata only; it never causes an attachment literal to be sent. */
  async fetchBodyStructures(uids: number[]): Promise<{ uid: number; bodyStructure: ImapBodyPart[] }[]> {
    if (uids.length === 0) return []
    const result = await this.run([`UID FETCH ${uids.join(',')} (UID BODYSTRUCTURE)`])
    return result.untagged.flatMap((response) => {
      const uid = Number(/\bUID\s+(\d+)/i.exec(response.text)?.[1])
      return Number.isSafeInteger(uid) && uid > 0
        ? [{ bodyStructure: parseImapBodyStructure(response.text), uid }]
        : []
    })
  }

  /**
   * A portable partial section fetch.  `BODY.PEEK` preserves read state, while
   * `<0.n>` gives the wire reader a hard bound even when an attachment is huge.
   */
  async fetchBodySection(uid: number, section: string, maxBytes: number): Promise<Buffer | null> {
    if (!Number.isSafeInteger(uid) || uid < 1 || !/^(?:TEXT|\d+(?:\.\d+)*)$/.test(section)
      || !Number.isSafeInteger(maxBytes) || maxBytes < 1) {
      throw new ImapError('The mail server request was invalid.', 'protocol')
    }
    const result = await this.run([`UID FETCH ${uid} (UID BODY.PEEK[${section}]<0.${maxBytes}>)`])
    const response = result.untagged.find((item) => /\bFETCH\b/i.test(item.text)
      && new RegExp(`\\bUID\\s+${uid}\\b`, 'i').test(item.text))
    return response?.literals[0] ?? null
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

/** Extract every parenthesised UID group from a THREAD response. */
export const parseThreadReferenceSets = (text: string): number[][] => {
  const sets: number[][] = []
  const stack: number[][] = []
  let current = ''
  const flush = () => {
    const value = Number(current)
    if (Number.isSafeInteger(value) && value > 0 && stack.length > 0) stack[0]?.push(value)
    current = ''
  }
  for (const character of text.replace(/^\*\s+THREAD\s*/i, '')) {
    if (/\d/.test(character)) {
      current += character
      continue
    }
    flush()
    if (character === '(') {
      if (stack.length === 0) {
        const group: number[] = []
        sets.push(group)
        stack.push(group)
      } else {
        stack.push(stack[0] ?? [])
      }
    } else if (character === ')') {
      stack.pop()
    }
  }
  flush()
  return sets.filter((group) => group.length > 0)
}
