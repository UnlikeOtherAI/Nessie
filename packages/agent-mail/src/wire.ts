import type { Socket } from 'node:net'

/**
 * The line-and-literal reader SMTP and IMAP share.
 *
 * Both are CRLF line protocols over a raw socket, and both need the same three
 * guarantees that a naive `socket.on('data')` loop does not give: every read is
 * bounded by a deadline (a server that accepts the connection and then says
 * nothing must not hold a worker forever), every read is bounded in *size* (a
 * hostile or broken server must not stream a mailbox into memory), and a
 * socket error surfaces at the read rather than as an unhandled event.
 *
 * IMAP additionally sends counted literals — `{1234}` followed by exactly that
 * many raw bytes, which may contain CRLF — so byte reads and line reads have to
 * come from one buffer. Two readers would disagree about where a literal ends.
 */

export class MailWireError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MailWireError'
  }
}

export type MailWireOptions = {
  /** Per-read deadline. A stalled server fails here, not on the run's budget. */
  timeoutMs: number
  /** Ceiling on unconsumed bytes held in memory at once. */
  maxBufferBytes: number
}

export class MailWire {
  private buffered: Buffer = Buffer.alloc(0)

  private failure: Error | null = null

  private ended = false

  private notify: (() => void) | null = null

  constructor(
    private readonly socket: Socket,
    private readonly options: MailWireOptions,
  ) {
    socket.on('data', (chunk: Buffer) => {
      this.buffered = Buffer.concat([this.buffered, chunk])
      if (this.buffered.byteLength > this.options.maxBufferBytes) {
        this.fail(new MailWireError('The mail server sent more data than allowed.'))
        return
      }
      this.wake()
    })
    socket.on('error', (error: Error) => this.fail(error))
    socket.on('close', () => {
      this.ended = true
      this.wake()
    })
    socket.on('end', () => {
      this.ended = true
      this.wake()
    })
  }

  /**
   * Replace the socket the wire reads from. STARTTLS hands the same connection
   * to a TLS socket, and the buffer must travel with it — anything already read
   * is plaintext that was legitimately sent before the upgrade.
   */
  static reattach(previous: MailWire, socket: Socket): MailWire {
    if (previous.buffered.byteLength > 0) {
      // Bytes sitting unread across a STARTTLS boundary are the classic command
      // -injection vector: they were written by whoever could reach the
      // plaintext socket and would be replayed as if they had arrived encrypted.
      throw new MailWireError('The mail server sent data before TLS was established.')
    }
    return new MailWire(socket, previous.options)
  }

  private fail(error: Error): void {
    this.failure ??= error
    this.wake()
  }

  private wake(): void {
    const notify = this.notify
    this.notify = null
    notify?.()
  }

  private async waitForData(): Promise<void> {
    if (this.failure) throw this.failure
    if (this.ended) throw new MailWireError('The mail server closed the connection.')
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.notify = null
        reject(new MailWireError('The mail server did not respond in time.'))
      }, this.options.timeoutMs)
      this.notify = () => {
        clearTimeout(timer)
        resolve()
      }
    })
    if (this.failure) throw this.failure
  }

  /** One CRLF-terminated line, without its terminator. */
  async readLine(): Promise<string> {
    for (;;) {
      const index = this.buffered.indexOf('\r\n')
      if (index >= 0) {
        const line = this.buffered.subarray(0, index).toString('utf8')
        this.buffered = this.buffered.subarray(index + 2)
        return line
      }
      await this.waitForData()
    }
  }

  /** Exactly `length` bytes — an IMAP literal, which may contain CRLF. */
  async readExact(length: number): Promise<Buffer> {
    if (length > this.options.maxBufferBytes) {
      throw new MailWireError('The mail server announced a larger message than allowed.')
    }
    while (this.buffered.byteLength < length) {
      await this.waitForData()
    }
    const bytes = this.buffered.subarray(0, length)
    this.buffered = this.buffered.subarray(length)
    return Buffer.from(bytes)
  }

  write(data: string | Buffer): void {
    if (this.failure) throw this.failure
    this.socket.write(data)
  }

  close(): void {
    this.socket.destroy()
  }
}
