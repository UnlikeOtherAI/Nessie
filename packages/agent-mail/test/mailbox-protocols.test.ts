import assert from 'node:assert/strict'
import { connect, createServer, type Server, type Socket } from 'node:net'
import { after, describe, test } from 'node:test'

import { ImapSession } from '../src/imap.js'
import { MailWire, MailWireError } from '../src/wire.js'
import { closeSmtpSession, runSmtpHandshake, sendOverSmtp } from '../src/smtp.js'
import { dialPlain, dialTls } from '../src/dial.js'
import type { MailEndpoint } from '../src/dial.js'

/**
 * The SMTP and IMAP clients driven against a scripted server over a real
 * socket. Loopback is refused by the dialer on purpose, so these exercise the
 * protocol half (`runSmtpHandshake` / `ImapSession.handshake`) and the dial's
 * refusals are asserted separately below.
 */

const servers: Server[] = []

after(() => {
  for (const server of servers) server.close()
})

/** A server that replies to each received line from a script. */
const scriptedServer = async (
  handle: (line: string, socket: Socket) => void,
  greeting: string,
): Promise<number> => {
  const server = createServer((socket) => {
    socket.on('error', () => undefined)
    socket.write(greeting)
    let buffer = ''
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8')
      for (;;) {
        const index = buffer.indexOf('\r\n')
        if (index < 0) break
        const line = buffer.slice(0, index)
        buffer = buffer.slice(index + 2)
        handle(line, socket)
      }
    })
  })
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return (server.address() as { port: number }).port
}

const openSocket = (port: number): Promise<Socket> =>
  new Promise((resolve, reject) => {
    const socket = connect({ host: '127.0.0.1', port })
    socket.once('connect', () => resolve(socket))
    socket.once('error', reject)
  })

const endpoint = (security: MailEndpoint['security']): MailEndpoint => ({
  host: 'mail.example.com',
  port: 993,
  security,
})

const options = { clientName: 'example.com', timeoutMs: 2_000 }

describe('SMTP client', () => {
  test('greets, authenticates and delivers a message', async () => {
    const seen: string[] = []
    let body = ''
    let inData = false
    const port = await scriptedServer((line, socket) => {
      if (inData) {
        if (line === '.') {
          inData = false
          socket.write('250 2.0.0 Ok: queued as ABC\r\n')
          return
        }
        body += `${line}\n`
        return
      }
      seen.push(line)
      if (line.startsWith('EHLO')) {
        socket.write('250-mail.example.com\r\n250-AUTH PLAIN LOGIN\r\n250 SIZE 10240000\r\n')
        return
      }
      if (line.startsWith('AUTH PLAIN')) {
        socket.write('235 2.7.0 Authentication successful\r\n')
        return
      }
      if (line.startsWith('MAIL FROM') || line.startsWith('RCPT TO')) {
        socket.write('250 2.1.0 Ok\r\n')
        return
      }
      if (line === 'DATA') {
        inData = true
        socket.write('354 End data with <CR><LF>.<CR><LF>\r\n')
        return
      }
      if (line === 'QUIT') socket.write('221 2.0.0 Bye\r\n')
    }, '220 mail.example.com ESMTP\r\n')

    const session = await runSmtpHandshake(
      await openSocket(port),
      endpoint('tls'),
      { password: 'hunter2', username: 'agent@example.com' },
      options,
    )
    await sendOverSmtp(session, {
      from: 'agent@example.com',
      mime: 'Subject: Hi\r\n\r\nHello\r\n.\r\nnot the end\r\n',
      recipients: ['someone@example.org'],
    })
    closeSmtpSession(session)

    const auth = seen.find((line) => line.startsWith('AUTH PLAIN'))
    assert.ok(auth, 'the client authenticated')
    assert.equal(
      Buffer.from(auth.slice('AUTH PLAIN '.length), 'base64').toString('utf8'),
      '\0agent@example.com\0hunter2',
    )
    assert.ok(seen.includes('MAIL FROM:<agent@example.com>'))
    assert.ok(seen.includes('RCPT TO:<someone@example.org>'))
    // A body line of "." must arrive dot-stuffed, or it would end the message
    // early and the rest would be interpreted as SMTP commands.
    assert.ok(body.includes('..'), 'the lone dot was stuffed')
    assert.ok(body.includes('not the end'), 'the body continued past the stuffed dot')
  })

  test('refuses to authenticate over a STARTTLS server that does not offer it', async () => {
    const port = await scriptedServer((line, socket) => {
      if (line.startsWith('EHLO')) socket.write('250-mail.example.com\r\n250 AUTH PLAIN\r\n')
    }, '220 mail.example.com ESMTP\r\n')

    await assert.rejects(
      runSmtpHandshake(
        await openSocket(port),
        endpoint('starttls'),
        { password: 'hunter2', username: 'agent@example.com' },
        options,
      ),
      /does not offer STARTTLS/,
      'a missing upgrade is a downgrade, not a fallback',
    )
  })

  test('reports a rejected password as an authentication failure', async () => {
    const port = await scriptedServer((line, socket) => {
      if (line.startsWith('EHLO')) socket.write('250-mail.example.com\r\n250 AUTH PLAIN\r\n')
      if (line.startsWith('AUTH PLAIN')) socket.write('535 5.7.8 Bad credentials\r\n')
    }, '220 mail.example.com ESMTP\r\n')

    await assert.rejects(
      runSmtpHandshake(
        await openSocket(port),
        endpoint('tls'),
        { password: 'wrong', username: 'agent@example.com' },
        options,
      ),
      (error: unknown) => (error as { kind?: string }).kind === 'auth',
      'only this shape flips a connection to needs_reauthorization',
    )
  })
})

describe('IMAP client', () => {
  /**
   * A server that consumes literals **by count**, the way a real IMAP server
   * must. Splitting its input on CRLF instead would tear a literal apart and
   * the test would be measuring the fake, not the client.
   */
  const imapServer = async (): Promise<{ port: number; seen: string[] }> => {
    const seen: string[] = []
    const server = createServer((socket) => {
      // The client destroys its socket on close; the reset that follows is
      // expected and must not surface as an unhandled error.
      socket.on('error', () => undefined)
      socket.write('* OK mail.example.com IMAP4rev1 ready\r\n')
      let buffer = Buffer.alloc(0)
      let literalRemaining = 0
      let tag = ''

      const pump = (): void => {
        for (;;) {
          if (literalRemaining > 0) {
            if (buffer.byteLength < literalRemaining) return
            seen.push(`LITERAL:${buffer.subarray(0, literalRemaining).toString('utf8')}`)
            buffer = buffer.subarray(literalRemaining)
            literalRemaining = 0
            continue
          }
          const index = buffer.indexOf('\r\n')
          if (index < 0) return
          const line = buffer.subarray(0, index).toString('utf8')
          buffer = buffer.subarray(index + 2)
          seen.push(line)
          // Only the start of a command carries the tag; a continuation line
          // (what follows a literal) must keep the tag already in flight.
          const leadingTag = /^(n\d+)\s/.exec(line)
          if (leadingTag?.[1]) tag = leadingTag[1]

          const literal = /\{(\d+)\}$/.exec(line)
          if (literal) {
            literalRemaining = Number(literal[1])
            socket.write('+ ready\r\n')
            continue
          }
          if (/UID SEARCH/i.test(line)) {
            socket.write(`* SEARCH 11 12 13\r\n${tag} OK SEARCH completed\r\n`)
            continue
          }
          if (/UID FETCH/i.test(line)) {
            const raw = 'Subject: Ping\r\nFrom: a@b.test\r\n\r\nBody with )\r\nand more\r\n'
            socket.write(
              `* 1 FETCH (UID 13 BODY[] {${Buffer.byteLength(raw)}}\r\n${raw})\r\n`
              + `${tag} OK FETCH completed\r\n`,
            )
            continue
          }
          socket.write(`${tag} OK done\r\n`)
        }
      }

      socket.on('data', (chunk: Buffer) => {
        buffer = Buffer.concat([buffer, chunk])
        pump()
      })
    })
    servers.push(server)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    return { port: (server.address() as { port: number }).port, seen }
  }

  test('sends every untrusted value as a counted literal', async () => {
    const { port, seen } = await imapServer()
    const session = await ImapSession.handshake(
      await openSocket(port),
      endpoint('tls'),
      // A password that would break out of a quoted string, and a folder name
      // with a CRLF in it — the injection this design exists to make impossible.
      { password: 'pa"ss\\word', username: 'agent@example.com' },
      { timeoutMs: 2_000 },
    )
    await session.selectFolder('INBOX"\r\nX LOGOUT')
    session.close()

    assert.ok(
      seen.some((line) => line === 'LITERAL:pa"ss\\word'),
      'the password went out as literal bytes, not as a quoted string',
    )
    assert.ok(
      seen.some((line) => line.startsWith('LITERAL:INBOX"')),
      'the folder name went out as literal bytes',
    )
    assert.ok(
      !seen.some((line) => /^X LOGOUT/.test(line)),
      'nothing inside a literal was ever read as a command',
    )
  })

  test('reads a literal body containing the characters that end a response', async () => {
    const { port } = await imapServer()
    const session = await ImapSession.handshake(
      await openSocket(port),
      endpoint('tls'),
      { password: 'x', username: 'agent@example.com' },
      { timeoutMs: 2_000 },
    )
    await session.selectFolder('INBOX')
    const uids = await session.searchUids(['ALL'])
    assert.deepEqual(uids, [13, 12, 11], 'search results come back newest first')

    const messages = await session.fetchMessages([13], 'full')
    session.close()
    assert.equal(messages.length, 1)
    assert.equal(messages[0]?.uid, 13)
    // The body contains ")" and CRLF, which would have ended the response had
    // the reader been line-based rather than length-prefixed.
    assert.ok(messages[0]?.raw.toString('utf8').includes('Body with )'))
    assert.ok(messages[0]?.raw.toString('utf8').includes('and more'))
  })
})

describe('the dialer', () => {
  test('refuses loopback and private addresses for both transports', async () => {
    await assert.rejects(
      dialPlain({ host: 'localhost', port: 25 }, { timeoutMs: 500 }),
      /private or local network/,
    )
    await assert.rejects(
      dialTls({ host: '127.0.0.1', port: 993 }, { timeoutMs: 500 }),
      /private or local network/,
    )
    await assert.rejects(
      dialTls({ host: '10.0.0.5', port: 993 }, { timeoutMs: 500 }),
      /private or local network/,
    )
    await assert.rejects(
      dialPlain({ host: '169.254.169.254', port: 25 }, { timeoutMs: 500 }),
      /private or local network/,
    )
  })

  test('refuses a host that resolves to a private address', async () => {
    await assert.rejects(
      dialTls(
        { host: 'mail.example.com', port: 993 },
        { resolveHost: async () => ['192.168.1.10'], timeoutMs: 500 },
      ),
      /private or local network/,
      'rebinding is closed by vetting what DNS returned, not just the name',
    )
  })

  test('refuses an out-of-range port before resolving anything', async () => {
    await assert.rejects(
      dialTls({ host: 'mail.example.com', port: 0 }, { timeoutMs: 500 }),
      /not valid/,
    )
  })
})

describe('the wire', () => {
  test('refuses to carry buffered plaintext across a STARTTLS upgrade', async () => {
    const port = await scriptedServer(() => undefined, 'garbage before TLS\r\n')
    const socket = await openSocket(port)
    const wire = new MailWire(socket, { maxBufferBytes: 1_000, timeoutMs: 1_000 })
    await new Promise((resolve) => setTimeout(resolve, 50))
    assert.throws(
      () => MailWire.reattach(wire, socket),
      MailWireError,
      'data written before the upgrade would otherwise replay as if encrypted',
    )
    wire.close()
  })

  test('stops a server that streams more than the cap', async () => {
    const port = await scriptedServer(() => undefined, 'x'.repeat(4_000))
    const socket = await openSocket(port)
    const wire = new MailWire(socket, { maxBufferBytes: 128, timeoutMs: 1_000 })
    await assert.rejects(wire.readLine(), /more data than allowed/)
    wire.close()
  })

  test('gives up on a server that never answers', async () => {
    const port = await scriptedServer(() => undefined, '')
    const socket = await openSocket(port)
    const wire = new MailWire(socket, { maxBufferBytes: 1_000, timeoutMs: 60 })
    await assert.rejects(wire.readLine(), /did not respond in time/)
    wire.close()
  })
})
