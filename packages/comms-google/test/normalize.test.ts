import assert from 'node:assert/strict'
import { test } from 'node:test'

import { normalizeGmailDeletion, normalizeGmailMessage } from '../src/normalize.js'
import type { GmailMessage } from '../src/mime.js'

const b64url = (text: string): string =>
  Buffer.from(text, 'utf8').toString('base64url')

const message: GmailMessage = {
  id: 'MSG_1',
  threadId: 'THREAD_1',
  internalDate: '1784628000000',
  payload: {
    mimeType: 'multipart/alternative',
    headers: [
      { name: 'From', value: '"Sarah Doe" <sarah@example.com>' },
      { name: 'To', value: 'me@example.com, Bob <bob@example.com>' },
      { name: 'Cc', value: 'carol@example.com' },
      { name: 'Subject', value: 'Where is the deploy doc?' },
      { name: 'Date', value: 'Mon, 21 Jul 2026 10:00:00 +0000' },
    ],
    parts: [
      { mimeType: 'text/plain', body: { size: 5, data: b64url('body!') } },
    ],
  },
}

test('normalizes a Gmail message into the shared event shape', () => {
  const event = normalizeGmailMessage('me@example.com', message)
  assert.equal(event.provider, 'google')
  assert.equal(event.canonicalMessageId, 'google:me@example.com:THREAD_1:MSG_1')
  assert.equal(event.conversationId, 'THREAD_1')
  assert.equal(event.threadId, 'THREAD_1')
  assert.equal(event.messageId, 'MSG_1')
  assert.equal(event.eventType, 'message.created')
  assert.equal(event.visibility, 'private-mailbox')
  assert.equal(event.isDeleted, false)
  assert.equal(event.subject, 'Where is the deploy doc?')
  assert.equal(event.contentText, 'body!')
  assert.equal(event.occurredAt, '2026-07-21T10:00:00.000Z')
  assert.equal(event.senderExternalId, 'sarah@example.com')
  assert.equal(event.senderDisplayName, 'Sarah Doe')
})

test('participants carry from/to/cc roles', () => {
  const event = normalizeGmailMessage('me@example.com', message)
  assert.deepEqual(event.participants, [
    { externalId: 'sarah@example.com', displayName: 'Sarah Doe', email: 'sarah@example.com', role: 'from' },
    { externalId: 'me@example.com', displayName: undefined, email: 'me@example.com', role: 'to' },
    { externalId: 'bob@example.com', displayName: 'Bob', email: 'bob@example.com', role: 'to' },
    { externalId: 'carol@example.com', displayName: undefined, email: 'carol@example.com', role: 'cc' },
  ])
})

test('falls back to the Date header when internalDate is absent', () => {
  const noInternal: GmailMessage = { ...message, internalDate: undefined }
  const event = normalizeGmailMessage('me@example.com', noInternal)
  assert.equal(event.occurredAt, '2026-07-21T10:00:00.000Z')
})

test('a deletion tombstone flips isDeleted with the same canonical id', () => {
  const event = normalizeGmailDeletion(
    'me@example.com',
    { threadId: 'THREAD_1', messageId: 'MSG_1' },
    '2026-07-21T11:00:00.000Z',
  )
  assert.equal(event.canonicalMessageId, 'google:me@example.com:THREAD_1:MSG_1')
  assert.equal(event.isDeleted, true)
  assert.equal(event.eventType, 'message.deleted')
})
