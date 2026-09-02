import assert from 'node:assert/strict'
import test from 'node:test'

import { buildAddress, normalizeAddress, validateLocalPart } from '../src/address.js'
import { buildOutboundMime, parseInboundEmail, replySubject } from '../src/mime.js'
import { resolveAgentMailReadiness } from '../src/readiness.js'
import { bounceIsPermanent, parseSesNotification } from '../src/ses-events.js'

test('inbound MIME parses into the stored shape, with HTML already sanitized', async () => {
  const raw = [
    'From: Petra <Petra@Example.COM>',
    'To: research@nessie.works',
    'Subject: Thursday works',
    'Message-ID: <M1@example.com>',
    'In-Reply-To: <M0@example.com>',
    'References: <M0@example.com>',
    'Content-Type: text/html; charset=utf-8',
    '',
    '<p>See you then</p><script>alert(1)</script><img src="https://t.example/p.gif">',
  ].join('\r\n')

  const parsed = await parseInboundEmail(raw)
  assert.equal(parsed.fromAddress, 'petra@example.com')
  assert.equal(parsed.fromName, 'Petra')
  assert.equal(parsed.subject, 'Thursday works')
  assert.equal(parsed.rfcMessageId, 'm1@example.com')
  assert.equal(parsed.inReplyTo, 'm0@example.com')
  assert.deepEqual(parsed.references, ['m0@example.com'])
  assert.equal(parsed.classification, 'normal')
  assert.equal(parsed.htmlBody?.includes('alert'), false)
  assert.equal(parsed.blockedRemoteContent, true)
  assert.match(parsed.textBody, /See you then/)
  assert.match(parsed.snippet, /See you then/)
})

test('a mailing-list message parses as bulk from its headers', async () => {
  const raw = [
    'From: list@example.com',
    'To: research@nessie.works',
    'Subject: [dev] weekly digest',
    'List-Id: <dev.example.com>',
    'Precedence: bulk',
    '',
    'digest body',
  ].join('\r\n')
  const parsed = await parseInboundEmail(raw)
  assert.equal(parsed.classification, 'bulk')
})

test('outbound MIME carries the caller-supplied Message-ID and threading headers', () => {
  const mime = buildOutboundMime({
    bcc: ['blind@example.com'],
    fromAddress: 'research@nessie.works',
    fromName: 'Research',
    inReplyTo: 'm1@example.com',
    messageId: 'out-1@nessie.works',
    references: ['m0@example.com', 'm1@example.com'],
    subject: 'Re: Thursday works',
    text: 'Confirmed.',
    to: ['petra@example.com'],
  })
  assert.match(mime, /^From: Research <research@nessie\.works>/m)
  assert.match(mime, /^Message-ID: <out-1@nessie\.works>/m)
  assert.match(mime, /^In-Reply-To: <m1@example\.com>/m)
  assert.match(mime, /^References: <m0@example\.com> <m1@example\.com>/m)
  // Blind recipients ride the SES API destination; a Bcc header would disclose
  // them to every other recipient.
  assert.equal(/^Bcc:/m.test(mime), false)
  assert.equal(mime.includes('blind@example.com'), false)
})

test('an outbound message round-trips back through the parser', async () => {
  const mime = buildOutboundMime({
    fromAddress: 'research@nessie.works',
    messageId: 'rt-1@nessie.works',
    subject: 'Ünïcode subject ✓',
    text: 'Body with ünïcode ✓',
    to: ['petra@example.com'],
  })
  const parsed = await parseInboundEmail(mime)
  assert.equal(parsed.subject, 'Ünïcode subject ✓')
  assert.equal(parsed.textBody, 'Body with ünïcode ✓')
  assert.equal(parsed.rfcMessageId, 'rt-1@nessie.works')
})

test('Re: is not stacked on a reply subject', () => {
  assert.equal(replySubject('Thursday'), 'Re: Thursday')
  assert.equal(replySubject('Re: Thursday'), 'Re: Thursday')
  assert.equal(replySubject('RE: Thursday'), 'RE: Thursday')
})

test('an SES receipt parses to envelope recipients, not to MIME headers', () => {
  const notification = parseSesNotification(
    JSON.stringify({
      mail: {
        commonHeaders: { to: ['decoy@other-tenant.example'] },
        destination: ['decoy@other-tenant.example'],
        messageId: 'ses-1',
        source: 'petra@example.com',
        timestamp: '2026-09-02T10:00:00.000Z',
      },
      notificationType: 'Received',
      receipt: {
        action: { bucketName: 'mail', objectKey: 'inbound/ses-1' },
        dmarcVerdict: { status: 'PASS' },
        recipients: ['Research@Nessie.Works'],
        spamVerdict: { status: 'PASS' },
        virusVerdict: { status: 'PASS' },
      },
    }),
  )
  assert.equal(notification?.kind, 'inbound')
  assert.deepEqual(
    notification?.kind === 'inbound' ? notification.envelopeRecipients : null,
    ['research@nessie.works'],
    'routing uses the envelope, which the sender cannot forge',
  )
  assert.equal(notification?.kind === 'inbound' ? notification.s3ObjectKey : null, 'inbound/ses-1')
})

test('bounce and complaint events parse, and only a permanent bounce suppresses', () => {
  const bounce = parseSesNotification(
    JSON.stringify({
      bounce: {
        bounceType: 'Permanent',
        bouncedRecipients: [{ emailAddress: 'gone@example.com' }],
        timestamp: '2026-09-02T10:00:00.000Z',
      },
      mail: { messageId: 'ses-2' },
      notificationType: 'Bounce',
    }),
  )
  assert.equal(bounce?.kind, 'bounce')
  assert.equal(bounce && bounce.kind !== 'inbound' ? bounceIsPermanent(bounce) : false, true)

  const transient = parseSesNotification(
    JSON.stringify({
      bounce: {
        bounceType: 'Transient',
        bouncedRecipients: [{ emailAddress: 'full@example.com' }],
        timestamp: '2026-09-02T10:00:00.000Z',
      },
      mail: { messageId: 'ses-3' },
      notificationType: 'Bounce',
    }),
  )
  assert.equal(
    transient && transient.kind !== 'inbound' ? bounceIsPermanent(transient) : true,
    false,
    'a full mailbox is reachable tomorrow — it must not retire a correspondent',
  )
})

test('an unrecognised SES payload is dropped, never guessed at', () => {
  assert.equal(parseSesNotification('{"hello":"world"}'), null)
  assert.equal(parseSesNotification('not json'), null)
})

test('local-part rules reject reserved, malformed and out-of-range names', () => {
  assert.equal(validateLocalPart('research').ok, true)
  assert.equal(validateLocalPart('Research').ok, true, 'case is normalized, not rejected')
  assert.equal(validateLocalPart('postmaster').ok, false)
  assert.equal(validateLocalPart('ab').ok, false)
  assert.equal(validateLocalPart('a..b').ok, false)
  assert.equal(validateLocalPart('-lead').ok, false)
  assert.equal(validateLocalPart('has space').ok, false)
  assert.equal(buildAddress('Research', 'Nessie.Works'), 'research@nessie.works')
})

test('address normalization extracts from a display-name header and refuses junk', () => {
  assert.equal(normalizeAddress('Petra <Petra@Example.com>'), 'petra@example.com')
  assert.equal(normalizeAddress('not-an-address'), null)
  assert.equal(normalizeAddress(null), null)
})

test('readiness names the exact missing variables rather than degrading quietly', () => {
  const readiness = resolveAgentMailReadiness({
    customDomains: false,
    inboundPrefix: '',
    inboundRetentionDays: 30,
    maxInboundBytes: 1,
    maxSendsPerHour: 1,
    sesRegion: 'eu-west-1',
    snsTopicArn: undefined,
  })
  assert.equal(readiness.ready, false)
  assert.deepEqual(
    readiness.ready === false ? readiness.missing : [],
    ['NESSIE_EMAIL_DOMAIN', 'NESSIE_EMAIL_INBOUND_S3_BUCKET', 'NESSIE_EMAIL_SNS_TOPIC_ARN'],
  )

  const ready = resolveAgentMailReadiness({
    customDomains: false,
    domain: 'Nessie.Works',
    inboundBucket: 'mail',
    inboundPrefix: 'inbound/',
    inboundRetentionDays: 30,
    maxInboundBytes: 1,
    maxSendsPerHour: 1,
    sesRegion: 'eu-west-1',
    snsTopicArn: 'arn:aws:sns:eu-west-1:1:t',
  })
  assert.equal(ready.ready, true)
  assert.equal(ready.ready === true ? ready.config.domain : null, 'nessie.works')
})
