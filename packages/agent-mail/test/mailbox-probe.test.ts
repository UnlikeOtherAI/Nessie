import assert from 'node:assert/strict'
import { connect, createServer, type Server, type Socket } from 'node:net'
import { after, describe, test } from 'node:test'

import {
  probeMailboxCapability,
  runImapCapabilityProbe,
  runSmtpCapabilityProbe,
} from '../src/mailbox-probe.js'
import type { MailEndpoint } from '../src/dial.js'

/**
 * The capability probe driven against scripted in-process servers over
 * loopback. The dialer refuses loopback on purpose, so — exactly as
 * `mailbox-protocols.test.ts` does for the real clients — these exercise the
 * conversation halves on an already-open socket, and the dial's own refusals
 * are asserted through `probeMailboxCapability` separately.
 */

const servers: Server[] = []

after(() => {
  for (const server of servers) server.close()
})

const scriptedServer = async (
  greeting: string,
  handle: (line: string, socket: Socket) => void,
): Promise<number> => {
  const server = createServer((socket) => {
    // The probe destroys its socket when it is done; the reset that follows is
    // expected and must not surface as an unhandled error.
    socket.on('error', () => undefined)
    if (greeting) socket.write(greeting)
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

const endpoint = (security: MailEndpoint['security'], port: number): MailEndpoint => ({
  host: 'mail.example.com',
  port,
  security,
})

const options = { clientName: 'mail.example.com', timeoutMs: 2_000 }

describe('the IMAP capability probe', () => {
  test('confirms a well-behaved server with a greeting, CAPABILITY and LOGOUT', async () => {
    const seen: string[] = []
    const port = await scriptedServer('* OK mail.example.com IMAP4rev1 ready\r\n', (line, socket) => {
      seen.push(line)
      const tag = /^(p\d+)\s/.exec(line)?.[1] ?? 'p0'
      if (/CAPABILITY/i.test(line)) {
        socket.write(`* CAPABILITY IMAP4rev1 IDLE\r\n${tag} OK CAPABILITY completed\r\n`)
        return
      }
      if (/LOGOUT/i.test(line)) socket.write(`* BYE\r\n${tag} OK LOGOUT completed\r\n`)
    })

    const outcome = await runImapCapabilityProbe(await openSocket(port), endpoint('tls', 993), options)
    assert.equal(outcome, 'confirmed')
    assert.ok(seen.some((line) => /CAPABILITY$/.test(line)), 'the probe asked for capabilities')
    assert.ok(seen.some((line) => /LOGOUT$/.test(line)), 'the probe said goodbye')
    // The point of the module: nothing resembling a credential is ever written.
    assert.ok(!seen.some((line) => /\bLOGIN\b|\bAUTHENTICATE\b/i.test(line)))
  })

  test('treats a STARTTLS endpoint that does not offer STARTTLS as insecure', async () => {
    const port = await scriptedServer('* OK mail.example.com IMAP4rev1 ready\r\n', (line, socket) => {
      const tag = /^(p\d+)\s/.exec(line)?.[1] ?? 'p0'
      if (/CAPABILITY/i.test(line)) {
        socket.write(`* CAPABILITY IMAP4rev1 IDLE\r\n${tag} OK CAPABILITY completed\r\n`)
      }
    })

    const outcome = await runImapCapabilityProbe(await openSocket(port), endpoint('starttls', 143), options)
    assert.equal(outcome, 'insecure', 'a missing upgrade is a downgrade, not a fallback')
  })

  test('reports a server that refuses the conversation as unreachable, not insecure', async () => {
    const refuses = await scriptedServer('* OK ready\r\n', (line, socket) => {
      const tag = /^(p\d+)\s/.exec(line)?.[1] ?? 'p0'
      socket.write(`${tag} NO not today\r\n`)
    })
    assert.equal(
      await runImapCapabilityProbe(await openSocket(refuses), endpoint('tls', 993), options),
      'unreachable',
    )

    const notImap = await scriptedServer('220 this is not an IMAP server\r\n', () => undefined)
    assert.equal(
      await runImapCapabilityProbe(await openSocket(notImap), endpoint('tls', 993), options),
      'unreachable',
    )
  })
})

describe('the SMTP capability probe', () => {
  test('confirms a well-behaved server with a greeting, EHLO and QUIT', async () => {
    const seen: string[] = []
    const port = await scriptedServer('220 mail.example.com ESMTP\r\n', (line, socket) => {
      seen.push(line)
      if (line.startsWith('EHLO')) {
        socket.write('250-mail.example.com\r\n250-AUTH PLAIN LOGIN\r\n250 SIZE 10240000\r\n')
        return
      }
      if (line === 'QUIT') socket.write('221 2.0.0 Bye\r\n')
    })

    const outcome = await runSmtpCapabilityProbe(await openSocket(port), endpoint('tls', 465), options)
    assert.equal(outcome, 'confirmed')
    assert.ok(seen.includes('EHLO mail.example.com'))
    assert.ok(seen.includes('QUIT'))
    assert.ok(!seen.some((line) => /^AUTH\b/i.test(line)), 'the probe never authenticates')
  })

  test('treats a STARTTLS endpoint that does not offer STARTTLS as insecure', async () => {
    const port = await scriptedServer('220 mail.example.com ESMTP\r\n', (line, socket) => {
      if (line.startsWith('EHLO')) socket.write('250-mail.example.com\r\n250 AUTH PLAIN\r\n')
    })

    const outcome = await runSmtpCapabilityProbe(await openSocket(port), endpoint('starttls', 587), options)
    assert.equal(outcome, 'insecure')
  })

  test('reports a refused greeting as unreachable', async () => {
    const port = await scriptedServer('554 no service here\r\n', () => undefined)
    assert.equal(
      await runSmtpCapabilityProbe(await openSocket(port), endpoint('tls', 465), options),
      'unreachable',
    )
  })
})

describe('the probed endpoint pair', () => {
  const config = (imapPort: number, smtpPort: number) => ({
    imap: { host: '127.0.0.1', port: imapPort, security: 'tls' as const },
    smtp: { host: '127.0.0.1', port: smtpPort, security: 'tls' as const },
    username: 'email_address' as const,
  })

  test('skips a port outside the mail set without dialling anything', async () => {
    // 127.0.0.1 is refused by the dialer, so a dial would answer `unreachable`.
    // `skipped` is only reachable by returning before the dial happens.
    assert.equal(await probeMailboxCapability(config(2_093, 465), { clientName: 'mail.example' }), 'skipped')
    assert.equal(await probeMailboxCapability(config(993, 8_025), { clientName: 'mail.example' }), 'skipped')
    assert.equal(
      await probeMailboxCapability(config(993, 465), { clientName: 'mail.example' }),
      'unreachable',
      'an allowed port does dial, and the dialer refuses loopback',
    )
  })
})
