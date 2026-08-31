import assert from 'node:assert/strict'
import test from 'node:test'

import * as ReactNamespace from 'react'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { AlertRow } from '../src/components/shared/AlertRow.js'
import { getAlertLink, type UserAlertRecord } from '../src/facades/alerts/hooks.js'

// The production Vite transform injects the JSX runtime. Node's lightweight
// tsx loader uses the classic transform for imported TSX modules.
;(globalThis as typeof globalThis & { React: typeof ReactNamespace }).React = ReactNamespace

const missedCall: UserAlertRecord = {
  actorAgentId: null,
  actorDisplayName: 'Alice',
  actorUserId: '11111111-1111-1111-1111-111111111111',
  channelId: '22222222-2222-2222-2222-222222222222',
  channelLabel: 'design',
  createdAt: '2026-08-31T12:00:00.000Z',
  id: '33333333-3333-3333-3333-333333333333',
  kind: 'call_missed',
  knowledgePageId: null,
  messageId: '44444444-4444-4444-4444-444444444444',
  projectId: null,
  readAt: null,
  rootMessageId: null,
  taskId: null,
  threadId: null,
  triggerId: null,
}

test('a missed call alert names the call and never claims it was a mention', () => {
  const html = renderToStaticMarkup(createElement(AlertRow, { alert: missedCall }))

  assert.match(html, /Missed call from Alice in design/)
  assert.doesNotMatch(html, /mentioned you/)
})

test('a missed call has an explicit link to its channel message', () => {
  assert.deepEqual(getAlertLink(missedCall), {
    state: { highlightMessageId: missedCall.messageId as string },
    to: `/channels/${missedCall.channelId}`,
  })
})
