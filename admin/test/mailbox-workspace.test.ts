import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import type { EmailMessageRecord } from '@nessie/schemas'
import * as React from 'react'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { MailConversation } from '../src/components/features/mailbox/MailConversation.js'
import {
  MailboxThreadList,
  MailboxWorkspace,
  type MailboxThreadSummary,
} from '../src/components/features/mailbox/MailboxWorkspace.js'

;(globalThis as typeof globalThis & { React: typeof React }).React = React

const source = (relativePath: string): string =>
  readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), 'utf8')

const thread = (overrides: Partial<MailboxThreadSummary> = {}): MailboxThreadSummary => ({
  awaitingApproval: false,
  hasBounce: false,
  id: '00000000-0000-4000-8000-000000000001',
  lastMessageAt: '2026-09-04T09:00:00.000Z',
  messageCount: 2,
  participants: ['supplier@example.com'],
  snippet: 'The revised quote is attached.',
  subject: 'Revised quote',
  ...overrides,
})

const message = (overrides: Partial<EmailMessageRecord> = {}): EmailMessageRecord => ({
  attachments: [],
  ccAddresses: [],
  classification: 'normal',
  deliveryState: 'sent',
  direction: 'inbound',
  fromAddress: 'supplier@example.com',
  fromName: 'Supplier',
  htmlBody: null,
  id: '00000000-0000-4000-8000-000000000002',
  occurredAt: '2026-09-04T09:00:00.000Z',
  snippet: 'The revised quote is attached.',
  subject: 'Revised quote',
  textBody: 'The revised quote is attached.',
  toAddresses: ['agent@nessie.example'],
  ...overrides,
})

test('mail threads are one keyboard-selectable listbox with a non-colour unread state', () => {
  const markup = renderToStaticMarkup(createElement(MailboxThreadList, {
    onSelect: () => undefined,
    selectedId: thread().id,
    threads: [thread({ unread: true })],
  }))

  assert.match(markup, /role="listbox"/)
  assert.match(markup, /role="option"/)
  assert.match(markup, /aria-selected="true"/)
  assert.match(markup, /Unread/)
  assert.match(markup, /message/)

  const unselected = renderToStaticMarkup(createElement(MailboxThreadList, {
    onSelect: () => undefined,
    threads: [thread(), thread({ id: '00000000-0000-4000-8000-000000000003' })],
  }))
  assert.match(unselected, /tabindex="0"/)
})

test('the workspace is bounded and changes its grid composition with the shell layout', () => {
  const render = (layout: 'single' | 'split'): string => renderToStaticMarkup(
    createElement(MailboxWorkspace, {
      conversation: createElement('section', null, 'Reading'),
      conversationList: createElement('aside', null, 'Threads'),
      layout,
    }),
  )

  const single = render('single')
  const split = render('split')
  assert.match(single, /data-layout="single"/)
  assert.match(single, /grid-rows/)
  assert.match(split, /data-layout="split"/)
  assert.match(split, /grid-cols/)
  assert.match(split, /min-h-0/)
  assert.match(split, /min-w-0/)
})

test('the conversation renderer keeps EmailMessageBody remote images opt-in', () => {
  const markup = renderToStaticMarkup(createElement(MailConversation, {
    messages: [message({
      htmlBody: '<img data-blocked-src="https://tracker.example/open.gif" alt="">',
    })],
    thread: thread(),
  }))

  assert.match(markup, /Remote images are blocked/)
  assert.match(markup, /Load images/)
  assert.match(markup, /data-blocked-src=/)
})

test('the hosted page consumes the shared renderer without a bespoke dialog or navigation path', () => {
  const page = source('../src/pages/AgentMailboxPage.tsx')

  assert.match(page, /<MailboxWorkspace/)
  assert.match(page, /<MailboxThreadList/)
  assert.match(page, /<MailConversation/)
  assert.doesNotMatch(page, /<Dialog|useOverlay|navigate\(/)
  assert.doesNotMatch(page, /EmailMessageBody/)
})
