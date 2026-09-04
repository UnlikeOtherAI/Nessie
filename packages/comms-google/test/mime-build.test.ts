import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  MimeBuildError,
  buildRawMessage,
  canonicalDraftFingerprintInput,
} from '../src/gmail/mime-build.js'

const decode = (raw: string): string =>
  Buffer.from(raw, 'base64url').toString('utf8')

test('builds an RFC 5322 message with the expected headers', () => {
  const raw = decode(buildRawMessage({
    to: ['a@example.com', 'b@example.com'],
    cc: ['c@example.com'],
    subject: 'Quarterly update',
    body: 'Hello there.',
  }))
  assert.match(raw, /^To: a@example\.com, b@example\.com\r\n/)
  assert.match(raw, /\r\nCc: c@example\.com\r\n/)
  assert.match(raw, /\r\nSubject: Quarterly update\r\n/)
  assert.match(raw, /\r\nMIME-Version: 1\.0\r\n/)
  // Gmail sets the sender from the authenticated account; letting a caller
  // name one is how you send as somebody else.
  assert.ok(!/\r\nFrom:/i.test(raw))
})

test('canonicalizes reply Message-IDs to exactly one bracket pair', () => {
  const raw = decode(buildRawMessage({
    to: ['a@example.com'], subject: 'Re: update', body: 'Thanks',
    inReplyTo: '<<parent@example.com>>',
    references: ['<root@example.com>', 'child@example.com'],
  }))
  assert.match(raw, /In-Reply-To: <parent@example\.com>/)
  assert.match(raw, /References: <root@example\.com> <child@example\.com>/)
  assert.doesNotMatch(raw, /<<|>>/)
})

// Header injection: the model writes these values, so a newline in a subject
// must never be able to add a real Bcc.
test('refuses a line break in any header value', () => {
  assert.throws(
    () => buildRawMessage({
      to: ['a@example.com'],
      subject: 'Hi\r\nBcc: sneaky@evil.test',
      body: 'x',
    }),
    MimeBuildError,
  )
  assert.throws(
    () => buildRawMessage({
      to: ['a@example.com'],
      subject: 'Hi',
      body: 'x',
      inReplyTo: 'abc\r\nX-Evil: 1',
    }),
    MimeBuildError,
  )
})

test('refuses an address that would corrupt the envelope', () => {
  for (const bad of ['not-an-address', 'a@b', 'a b@example.com', 'a@example.com, x@y.z']) {
    assert.throws(
      () => buildRawMessage({ to: [bad], subject: 's', body: 'b' }),
      MimeBuildError,
      `${bad} should be rejected`,
    )
  }
})

test('requires at least one recipient', () => {
  assert.throws(
    () => buildRawMessage({ to: [], subject: 's', body: 'b' }),
    MimeBuildError,
  )
})

test('de-duplicates recipients', () => {
  const raw = decode(buildRawMessage({
    to: ['a@example.com', 'a@example.com'],
    subject: 's',
    body: 'b',
  }))
  assert.match(raw, /\r?^To: a@example\.com\r\n/m)
})

// A subject in Czech or Japanese is ordinary, not an edge case.
test('encodes a non-ASCII subject per RFC 2047', () => {
  const raw = decode(buildRawMessage({
    to: ['a@example.com'],
    subject: 'Přehled výsledků',
    body: 'x',
  }))
  assert.match(raw, /\r\nSubject: =\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=\r\n/)
})

test('round-trips a non-ASCII body through base64', () => {
  const raw = decode(buildRawMessage({
    to: ['a@example.com'],
    subject: 's',
    body: 'Ahoj — jak se máš? 🙂',
  }))
  const base64 = raw.split('\r\n\r\n').slice(1).join('\r\n\r\n').replace(/\r\n/g, '')
  assert.equal(Buffer.from(base64, 'base64').toString('utf8'), 'Ahoj — jak se máš? 🙂')
})

test('an HTML alternative produces multipart/alternative', () => {
  const raw = decode(buildRawMessage({
    to: ['a@example.com'],
    subject: 's',
    body: 'plain',
    bodyHtml: '<p>rich</p>',
  }))
  assert.match(raw, /Content-Type: multipart\/alternative; boundary="/)
  assert.match(raw, /Content-Type: text\/html; charset="UTF-8"/)
})

test('an attachment produces multipart/mixed with a disposition', () => {
  const raw = decode(buildRawMessage({
    to: ['a@example.com'],
    subject: 's',
    body: 'see attached',
    attachments: [{
      filename: 'report.pdf',
      mimeType: 'application/pdf',
      content: Buffer.from('%PDF-1.4 fake'),
    }],
  }))
  assert.match(raw, /Content-Type: multipart\/mixed; boundary="/)
  assert.match(raw, /Content-Disposition: attachment; filename="report\.pdf"/)
})

// ── the fingerprint an approval binds to ────────────────────────────────────

test('the fingerprint ignores recipient order and case', () => {
  const a = canonicalDraftFingerprintInput({
    to: ['B@Example.com', 'a@example.com'],
    subject: 'Hi',
    body: 'body',
  })
  const b = canonicalDraftFingerprintInput({
    to: ['a@EXAMPLE.com', 'b@example.com'],
    subject: 'Hi',
    body: 'body',
  })
  assert.equal(a, b)
})

test('the fingerprint changes when a recipient is added', () => {
  const before = canonicalDraftFingerprintInput({
    to: ['a@example.com'],
    subject: 'Hi',
    body: 'body',
  })
  const after = canonicalDraftFingerprintInput({
    to: ['a@example.com', 'attacker@evil.test'],
    subject: 'Hi',
    body: 'body',
  })
  assert.notEqual(before, after)
})

test('the fingerprint changes when the body or subject changes', () => {
  const base = { to: ['a@example.com'], subject: 'Hi', body: 'body' }
  assert.notEqual(
    canonicalDraftFingerprintInput(base),
    canonicalDraftFingerprintInput({ ...base, body: 'body ' }),
  )
  assert.notEqual(
    canonicalDraftFingerprintInput(base),
    canonicalDraftFingerprintInput({ ...base, subject: 'Hi!' }),
  )
})

test('the fingerprint covers bcc and attachments', () => {
  const base = { to: ['a@example.com'], subject: 'Hi', body: 'b' }
  assert.notEqual(
    canonicalDraftFingerprintInput(base),
    canonicalDraftFingerprintInput({ ...base, bcc: ['x@example.com'] }),
  )
  assert.notEqual(
    canonicalDraftFingerprintInput(base),
    canonicalDraftFingerprintInput({ ...base, attachmentIds: ['att-1'] }),
  )
})
