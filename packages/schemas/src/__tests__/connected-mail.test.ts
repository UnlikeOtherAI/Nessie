import assert from 'node:assert/strict'
import test from 'node:test'

import {
  ConnectedMailComposeInputSchema,
  ConnectedMailDraftCreateInputSchema,
  ConnectedMailboxSendInputSchema,
  ConnectedMailMessageSchema,
  ConnectedMailThreadsQuerySchema,
} from '../connected-mail.js'

test('connected mail compose input refuses a client-supplied sender', () => {
  const result = ConnectedMailComposeInputSchema.safeParse({
    body: 'Hello',
    from: 'spoofed@example.test',
    subject: 'Hi',
    to: ['recipient@example.test'],
  })
  assert.equal(result.success, false)
})

test('Gmail draft creation requires a stable idempotency key', () => {
  const base = { body: 'Hello', subject: 'Hi', to: ['recipient@example.test'] }
  assert.equal(ConnectedMailDraftCreateInputSchema.safeParse(base).success, false)
  assert.equal(ConnectedMailDraftCreateInputSchema.safeParse({
    ...base, idempotencyKey: '00000000-0000-4000-8000-000000000001',
  }).success, true)
})

test('SMTP send requires a stable idempotency key', () => {
  const base = { body: 'Hello', subject: 'Hi', to: ['recipient@example.test'] }
  assert.equal(ConnectedMailboxSendInputSchema.safeParse(base).success, false)
  assert.equal(ConnectedMailboxSendInputSchema.safeParse({
    ...base, idempotencyKey: '00000000-0000-4000-8000-000000000002',
  }).success, true)
})

test('connected mail compose input refuses line-break recipient and header injection', () => {
  const base = { body: 'Hello', subject: 'Hi', to: ['recipient@example.test'] }
  assert.equal(ConnectedMailComposeInputSchema.safeParse({
    ...base, to: ['recipient@example.test\r\nBcc: attacker@example.test'],
  }).success, false)
  assert.equal(ConnectedMailComposeInputSchema.safeParse({
    ...base, subject: 'Hi\nBcc: attacker@example.test',
  }).success, false)
  assert.equal(ConnectedMailComposeInputSchema.safeParse({
    ...base, inReplyTo: 'parent@example.test\r\nReferences: attacker@example.test',
  }).success, false)
})

test('connected mail list paging is bounded and query text is optional', () => {
  assert.deepEqual(ConnectedMailThreadsQuerySchema.parse({}), { pageSize: 25 })
  assert.equal(ConnectedMailThreadsQuerySchema.parse({ unreadOnly: 'false' }).unreadOnly, false)
  assert.equal(ConnectedMailThreadsQuerySchema.safeParse({ unreadOnly: '1' }).success, false)
  assert.equal(ConnectedMailThreadsQuerySchema.safeParse({ pageSize: 101 }).success, false)
  assert.equal(ConnectedMailThreadsQuerySchema.safeParse({ query: '   ' }).success, false)
})

test('connected mail messages retain a bounded normalized RFC Message-ID', () => {
  const message = {
    attachments: [],
    blockedRemoteContent: false,
    body: 'safe body',
    bodyFormat: 'text' as const,
    cc: [],
    from: 'sender@example.test',
    id: 'provider-message-id',
    inReplyTo: '<parent@example.test>',
    messageId: 'child@example.test',
    receivedAt: '2026-09-04T12:00:00.000Z',
    subject: 'Hello',
    threadId: 'provider-thread-id',
    to: ['recipient@example.test'],
  }
  assert.equal(ConnectedMailMessageSchema.safeParse(message).success, true)
  assert.equal(ConnectedMailMessageSchema.safeParse({ ...message, messageId: 'x'.repeat(1001) }).success, false)
  assert.equal(ConnectedMailMessageSchema.safeParse({ ...message, body: 'x'.repeat(100_001) }).success, false)
})
