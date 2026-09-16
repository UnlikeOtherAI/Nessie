import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { ImapError } from '../src/imap.js'
import { MailDialError } from '../src/dial.js'
import { SmtpError } from '../src/smtp.js'
import { resolveMailboxEndpoints } from '../src/mailbox-resolve.js'
import type { MailEndpoint } from '../src/dial.js'
import type { MailboxProbeOutcome } from '../src/mailbox-probe.js'
import type { MailboxLegProtocol, MailboxResolveOptions } from '../src/mailbox-resolve.js'

/**
 * The resolver's decisions, not its sockets.
 *
 * The dialer refuses loopback by design, so there is no scripted local server
 * to resolve against; the protocol conversations are covered by
 * `mailbox-protocols.test.ts` and `mailbox-probe.test.ts` on their own. What is
 * only testable here is the part that is actually new — which endpoints are
 * tried, in what order, which of them a credential is allowed to reach, and
 * when the sweep stops.
 */

const request = {
  address: 'person@example.com',
  password: 'secret',
  username: 'person@example.com',
}

type Attempted = { protocol: MailboxLegProtocol; endpoint: MailEndpoint }

type HarnessScript = {
  /** Endpoints that accept the credential, as `host:port`. */
  accepts?: string[]
  /** Endpoints whose login throws, as `host:port` → the error to throw. */
  rejects?: Record<string, Error>
  /** Probe answers by `host:port`; anything unlisted is `confirmed`. */
  probes?: Record<string, MailboxProbeOutcome>
}

const key = (endpoint: MailEndpoint): string => `${endpoint.host}:${endpoint.port}`

const harness = (script: HarnessScript) => {
  const attempted: Attempted[] = []
  const probed: Attempted[] = []
  const options: MailboxResolveOptions = {
    attempt: async (protocol, endpoint) => {
      attempted.push({ endpoint, protocol })
      const rejection = script.rejects?.[key(endpoint)]
      if (rejection) throw rejection
      if (!script.accepts?.includes(key(endpoint))) {
        throw new MailDialError('nothing listening', 'network')
      }
    },
    probe: async (protocol, endpoint) => {
      probed.push({ endpoint, protocol })
      return script.probes?.[key(endpoint)] ?? 'confirmed'
    },
    timeoutMs: 1_000,
  }
  return { attempted, options, probed }
}

const authRejected = new ImapError('rejected', 'auth')

describe('resolving a mailbox from an address alone', () => {
  test('finds the conventional secure endpoints without being told any of them', async () => {
    const { attempted, options } = harness({
      accepts: ['imap.example.com:993', 'smtp.example.com:587'],
    })

    const resolution = await resolveMailboxEndpoints(request, options)

    assert.deepEqual(resolution.imap, {
      endpoint: { host: 'imap.example.com', port: 993, security: 'tls' },
      ok: true,
    })
    assert.deepEqual(resolution.smtp, {
      endpoint: { host: 'smtp.example.com', port: 587, security: 'starttls' },
      ok: true,
    })
    // The best guess first, and nothing tried after it succeeded.
    assert.equal(attempted.length, 2)
  })

  test('walks on to the next port when the first does not answer', async () => {
    const { attempted, options } = harness({
      accepts: ['imap.example.com:143', 'smtp.example.com:465'],
    })

    const resolution = await resolveMailboxEndpoints(request, options)

    assert.equal(resolution.imap.ok && resolution.imap.endpoint.port, 143)
    assert.equal(resolution.imap.ok && resolution.imap.endpoint.security, 'starttls')
    assert.equal(resolution.smtp.ok && resolution.smtp.endpoint.port, 465)
    assert.equal(resolution.smtp.ok && resolution.smtp.endpoint.security, 'tls')
    assert.deepEqual(
      attempted.filter((entry) => entry.protocol === 'imap').map((entry) => entry.endpoint.port),
      [993, 143],
    )
  })

  test('walks on to the next hostname when a whole host does not answer', async () => {
    const { attempted, options } = harness({
      accepts: ['mail.example.com:993', 'mail.example.com:587'],
    })

    const resolution = await resolveMailboxEndpoints(request, options)

    assert.equal(resolution.imap.ok && resolution.imap.endpoint.host, 'mail.example.com')
    assert.equal(resolution.smtp.ok && resolution.smtp.endpoint.host, 'mail.example.com')
    assert.deepEqual(
      attempted.filter((entry) => entry.protocol === 'imap').map((entry) => entry.endpoint.host),
      ['imap.example.com', 'imap.example.com', 'mail.example.com'],
    )
  })

  test('reports each leg separately, so a working inbox is not blamed for sending', async () => {
    const { options } = harness({ accepts: ['imap.example.com:993'] })

    const resolution = await resolveMailboxEndpoints(request, options)

    assert.equal(resolution.imap.ok, true)
    assert.equal(resolution.smtp.ok, false)
    assert.equal(!resolution.smtp.ok && resolution.smtp.failure, 'unreachable')
  })
})

describe('the credential gate on a guessed hostname', () => {
  test('probes a derived hostname before any password is dialled at it', async () => {
    const { attempted, options, probed } = harness({
      accepts: ['imap.example.com:993', 'smtp.example.com:587'],
    })

    await resolveMailboxEndpoints(request, options)

    assert.deepEqual(probed.map((entry) => key(entry.endpoint)), [
      'imap.example.com:993',
      'smtp.example.com:587',
    ])
    assert.deepEqual(attempted.map((entry) => key(entry.endpoint)), [
      'imap.example.com:993',
      'smtp.example.com:587',
    ])
  })

  test('never sends the credential to a derived host the probe did not confirm', async () => {
    const { attempted, options } = harness({
      // It would have accepted the password — the point is that it is never asked.
      accepts: ['imap.example.com:993', 'smtp.example.com:587'],
      probes: { 'imap.example.com:993': 'unreachable', 'smtp.example.com:587': 'insecure' },
    })

    const resolution = await resolveMailboxEndpoints(request, options)

    assert.equal(resolution.imap.ok, false)
    assert.equal(resolution.smtp.ok, false)
    for (const entry of attempted) {
      assert.notEqual(key(entry.endpoint), 'imap.example.com:993')
      assert.notEqual(key(entry.endpoint), 'smtp.example.com:587')
    }
  })

  test('an unverifiable derived host is reported as insecure, not as unreachable', async () => {
    const { options } = harness({ probes: { 'imap.example.com:993': 'insecure' } })

    const resolution = await resolveMailboxEndpoints(request, options)

    assert.equal(!resolution.imap.ok && resolution.imap.failure, 'insecure')
  })

  test('a hostname the person typed is dialled without asking the probe', async () => {
    const { options, probed } = harness({
      accepts: ['mx.corp.example:993', 'mx.corp.example:587'],
    })

    const resolution = await resolveMailboxEndpoints(
      { ...request, server: 'mx.corp.example' },
      options,
    )

    assert.deepEqual(probed, [])
    assert.equal(resolution.imap.ok && resolution.imap.endpoint.host, 'mx.corp.example')
    assert.equal(resolution.smtp.ok && resolution.smtp.endpoint.host, 'mx.corp.example')
  })

  test('a typed hostname is authoritative: no derived host is tried behind it', async () => {
    const { attempted, options } = harness({ accepts: ['imap.example.com:993'] })

    const resolution = await resolveMailboxEndpoints(
      { ...request, server: 'mx.corp.example' },
      options,
    )

    assert.equal(resolution.imap.ok, false)
    for (const entry of attempted) {
      assert.equal(entry.endpoint.host, 'mx.corp.example')
    }
  })

  test('refuses a server that is not a usable public hostname', async () => {
    const { attempted, options } = harness({})

    const resolution = await resolveMailboxEndpoints(
      { ...request, server: 'localhost' },
      options,
    )

    assert.equal(!resolution.imap.ok && resolution.imap.failure, 'no_candidate')
    assert.deepEqual(attempted, [])
  })
})

describe('stopping', () => {
  test('a rejected credential ends the leg rather than replaying the password', async () => {
    const { attempted, options } = harness({
      rejects: { 'imap.example.com:993': authRejected },
    })

    const resolution = await resolveMailboxEndpoints(request, options)

    assert.equal(!resolution.imap.ok && resolution.imap.failure, 'credential_rejected')
    assert.equal(attempted.length, 1)
  })

  test('a rejected credential ends the whole resolution, not just its leg', async () => {
    const { attempted, options } = harness({
      accepts: ['smtp.example.com:587'],
      rejects: { 'imap.example.com:993': authRejected },
    })

    const resolution = await resolveMailboxEndpoints(request, options)

    assert.equal(!resolution.smtp.ok && resolution.smtp.failure, 'credential_rejected')
    assert.deepEqual(attempted.map((entry) => entry.protocol), ['imap'])
  })

  test('an SMTP auth refusal is a rejected credential too', async () => {
    const { options } = harness({
      accepts: ['imap.example.com:993'],
      rejects: { 'smtp.example.com:587': new SmtpError('no', 535, 'auth') },
    })

    const resolution = await resolveMailboxEndpoints(request, options)

    assert.equal(!resolution.smtp.ok && resolution.smtp.failure, 'credential_rejected')
  })

  test('a certificate refusal on a typed host is insecure and keeps looking', async () => {
    const { attempted, options } = harness({
      accepts: ['mx.corp.example:143'],
      rejects: { 'mx.corp.example:993': new MailDialError('bad cert', 'certificate') },
    })

    const resolution = await resolveMailboxEndpoints(
      { ...request, server: 'mx.corp.example' },
      options,
    )

    assert.equal(resolution.imap.ok && resolution.imap.endpoint.port, 143)
    assert.deepEqual(
      attempted.filter((entry) => entry.protocol === 'imap').map((entry) => entry.endpoint.port),
      [993, 143],
    )
  })

  test('stops at the deadline instead of working through the matrix', async () => {
    const { attempted, options } = harness({})

    const resolution = await resolveMailboxEndpoints(request, {
      ...options,
      deadline: Date.now() - 1,
    })

    assert.deepEqual(attempted, [])
    assert.equal(resolution.imap.ok, false)
    assert.equal(resolution.smtp.ok, false)
  })
})

describe('settings the person stated', () => {
  test('an explicit port is the only one tried, and brings its own transport', async () => {
    const { attempted, options } = harness({
      accepts: ['mx.corp.example:465', 'imap.example.com:993'],
    })

    const resolution = await resolveMailboxEndpoints(
      { ...request, smtp: { host: 'mx.corp.example', port: 465 } },
      options,
    )

    assert.deepEqual(resolution.smtp, {
      endpoint: { host: 'mx.corp.example', port: 465, security: 'tls' },
      ok: true,
    })
    assert.deepEqual(
      attempted.filter((entry) => entry.protocol === 'smtp').map((entry) => entry.endpoint.port),
      [465],
    )
  })

  test('an explicit security is honoured over the port convention', async () => {
    const { options } = harness({ accepts: ['mx.corp.example:993'] })

    const resolution = await resolveMailboxEndpoints(
      { ...request, imap: { host: 'mx.corp.example', port: 993, security: 'starttls' } },
      options,
    )

    assert.equal(resolution.imap.ok && resolution.imap.endpoint.security, 'starttls')
  })

  test('one stated leg does not stop the other from being resolved', async () => {
    const { options } = harness({
      accepts: ['mx.corp.example:465', 'imap.example.com:993'],
    })

    const resolution = await resolveMailboxEndpoints(
      { ...request, smtp: { host: 'mx.corp.example', port: 465 } },
      options,
    )

    assert.equal(resolution.imap.ok && resolution.imap.endpoint.host, 'imap.example.com')
    assert.equal(resolution.smtp.ok && resolution.smtp.endpoint.host, 'mx.corp.example')
  })

  test('a leg host wins over the single server field', async () => {
    const { attempted, options } = harness({ accepts: ['imap.corp.example:993'] })

    await resolveMailboxEndpoints(
      { ...request, imap: { host: 'imap.corp.example' }, server: 'mail.corp.example' },
      options,
    )

    assert.equal(attempted[0]?.endpoint.host, 'imap.corp.example')
  })

  test('an unusable address with no stated host leaves nothing to try', async () => {
    const { attempted, options } = harness({})

    const resolution = await resolveMailboxEndpoints(
      { ...request, address: 'not-an-address' },
      options,
    )

    assert.equal(!resolution.imap.ok && resolution.imap.failure, 'no_candidate')
    assert.deepEqual(attempted, [])
  })
})
