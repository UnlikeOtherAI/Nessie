import assert from 'node:assert/strict'
import test from 'node:test'

import {
  GmailDraftCreateSchema,
  gmailReplyMessage,
} from '../src/run/pa-tools/gmail-tools.js'

test('Gmail draft reply carries the provider thread and RFC reply chain', () => {
  const args = GmailDraftCreateSchema.parse({
    to: ['recipient@example.com'], subject: 'Re: status', body: 'Thanks.',
    replyToThreadId: 'gmail-thread-1', replyToMessageId: 'parent@example.com',
  })
  assert.equal(args.replyToThreadId, 'gmail-thread-1')
  assert.deepEqual(gmailReplyMessage(args), {
    to: ['recipient@example.com'], subject: 'Re: status', body: 'Thanks.',
    inReplyTo: 'parent@example.com', references: ['parent@example.com'],
  })
})

test('Gmail draft reply rejects an unpaired thread or RFC Message-ID', () => {
  const base = { to: ['recipient@example.com'], subject: 'Re: status', body: 'Thanks.' }
  assert.equal(GmailDraftCreateSchema.safeParse({ ...base, replyToThreadId: 'thread-1' }).success, false)
  assert.equal(GmailDraftCreateSchema.safeParse({ ...base, replyToMessageId: 'parent@example.com' }).success, false)
})
