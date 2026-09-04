import assert from 'node:assert/strict'
import test from 'node:test'

import * as React from 'react'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import {
  GmailDraftCardView,
  readGmailDraftCard,
} from '../src/components/features/channels/GmailDraftCard.js'
import { readGoogleScopeRequest } from '../src/components/features/channels/GoogleScopeRequestCard.js'
import type { GmailDraftView } from '../src/facades/gmail/hooks.js'

;(globalThis as typeof globalThis & { React: typeof React }).React = React

const draft = (overrides: Partial<GmailDraftView> = {}): GmailDraftView => ({
  id: 'action-1',
  state: 'draft',
  revision: 1,
  contentFingerprint: 'fp-1',
  to: ['jana@example.com', 'tom@example.com'],
  cc: ['finance@example.com'],
  bcc: [],
  subject: 'Q3 numbers — draft for your review',
  body: 'Hi Jana,\n\nHere are the Q3 numbers.',
  attachments: [],
  editable: true,
  unsupportedReason: null,
  ...overrides,
})

const render = (props: Parameters<typeof GmailDraftCardView>[0]): string =>
  renderToStaticMarkup(createElement(GmailDraftCardView, props))

test('shows historical recipients, CC, subject and body without a second send UI', () => {
  const html = render({ data: draft() })
  assert.match(html, /jana@example\.com, tom@example\.com/)
  assert.match(html, /finance@example\.com/)
  assert.match(html, /Q3 numbers/)
  assert.match(html, /Here are the Q3 numbers\./)
  assert.doesNotMatch(html, /data-testid="gmail-draft-send"/)
  assert.doesNotMatch(html, /Discard/)
})

test('omits an address row that has no addresses', () => {
  // An empty "Bcc —" line is noise on every ordinary email.
  const html = render({ data: draft({ bcc: [] }) })
  assert.ok(!/>Bcc</.test(html))
})

test('a held send remains readable but has no second undo implementation', () => {
  const html = render({ data: draft({ state: 'sending' }) })
  assert.match(html, /Sending…/)
  assert.ok(!/data-testid="gmail-draft-send"/.test(html))
  assert.ok(!/data-testid="gmail-draft-undo"/.test(html))
})

test('a sent draft offers nothing to click', () => {
  const html = render({ data: draft({ state: 'sent' }) })
  assert.match(html, /Sent/)
  assert.ok(!/data-testid="gmail-draft-send"/.test(html))
  assert.ok(!/data-testid="gmail-draft-undo"/.test(html))
})

test('a discarded draft offers nothing to click', () => {
  const html = render({ data: draft({ state: 'discarded' }) })
  assert.match(html, /Discarded/)
  assert.ok(!/data-testid="gmail-draft-send"/.test(html))
})

test('attachments render as chips', () => {
  const html = render({
    data: draft({
      attachments: [{ filename: 'q3.pdf', mimeType: 'application/pdf', sizeBytes: 12 }],
    }),
  })
  assert.match(html, /q3\.pdf/)
})

test('a missing subject still reads as an email', () => {
  const html = render({ data: draft({ subject: '' }) })
  assert.match(html, /\(no subject\)/)
})

// ── metadata parsing: the card is server-authored, so anything else is ignored

test('only a well-formed gmail_draft card is rendered', () => {
  assert.deepEqual(
    readGmailDraftCard({ card: { kind: 'gmail_draft', draftActionId: 'a' } }),
    { draftActionId: 'a' },
  )
  assert.equal(readGmailDraftCard({ card: { kind: 'comms_connect' } }), null)
  assert.equal(readGmailDraftCard({ card: { kind: 'gmail_draft' } }), null)
  assert.equal(readGmailDraftCard({ card: 'nope' }), null)
  assert.equal(readGmailDraftCard(undefined), null)
})

test('a scope request only renders for a capability in the catalog', () => {
  assert.equal(
    readGoogleScopeRequest({
      card: { kind: 'google_scope_request', capabilityId: 'gmail.compose' },
    }),
    'gmail.compose',
  )
  // A capability id the client does not know is not rendered as a Grant button
  // for something unnamed.
  assert.equal(
    readGoogleScopeRequest({
      card: { kind: 'google_scope_request', capabilityId: 'drive.everything' },
    }),
    null,
  )
  assert.equal(readGoogleScopeRequest({ card: { kind: 'gmail_draft' } }), null)
})
