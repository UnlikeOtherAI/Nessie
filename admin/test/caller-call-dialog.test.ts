import assert from 'node:assert/strict'
import test from 'node:test'

import * as ReactNamespace from 'react'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { CallerCallDialog } from '../src/components/features/channels/CallerCallDialog.js'
import { CallBanner } from '../src/components/shared/CallBanner.js'
import type { CallRecord } from '../src/lib/api-client.js'

// The production Vite transform injects the JSX runtime. Node's lightweight
// tsx loader uses the classic transform for imported TSX modules.
;(globalThis as typeof globalThis & { React: typeof ReactNamespace }).React = ReactNamespace

const call: CallRecord = {
  channelId: '11111111-1111-1111-1111-111111111111',
  endedAt: null,
  id: '22222222-2222-2222-2222-222222222222',
  invites: [{
    displayName: 'Mina Patel',
    respondedAt: null,
    state: 'ringing',
    userId: '33333333-3333-3333-3333-333333333333',
  }],
  meetingUri: 'https://meet.example.com/space',
  participants: [],
  provider: 'google_meet',
  revision: 1,
  ringExpiresAt: '2026-08-31T12:10:00.000Z',
  roomId: null,
  startedAt: '2026-08-31T12:00:00.000Z',
  startedById: '44444444-4444-4444-4444-444444444444',
  status: 'ringing',
}

test('caller dialog keeps the link as an external anchor and exposes ringing state', () => {
  const html = renderToStaticMarkup(
    createElement(CallerCallDialog, {
      actionError: null,
      actionPending: false,
      call,
      channelLabel: 'design',
      onClose: () => undefined,
      onEndCall: () => undefined,
    }),
  )

  assert.match(html, /Call started/)
  assert.match(html, /href="https:\/\/meet\.example\.com\/space"/)
  assert.match(html, /rel="noopener noreferrer"/)
  assert.match(html, /target="_blank"/)
  assert.match(html, />Join call<\/a>/)
  assert.match(html, /Mina Patel/)
  // The caller popup never claims delivery — SSE may be down and push may be
  // denied — so an unanswered invitee reads as awaiting a response.
  assert.match(html, /Waiting for response/)
  assert.match(html, /Cancel call/)
})

test('call banner names the caller and joins through an anchor', () => {
  const html = renderToStaticMarkup(
    createElement(CallBanner, {
      callerName: 'Avery Chen',
      meetingUri: call.meetingUri as string,
    }),
  )

  assert.match(html, /Avery Chen started a call/)
  assert.match(html, /href="https:\/\/meet\.example\.com\/space"/)
  assert.match(html, />Join<\/a>/)
})
