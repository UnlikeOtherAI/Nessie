import assert from 'node:assert/strict'
import test from 'node:test'

import { MailSurfaceDoorwayMetadataSchema } from '../connected-mail.js'

const account = '3f0c8d0a-6b83-46dd-8fe2-5a9775f17f42'

test('mail-surface doorway metadata contains only a structural pointer', () => {
  const doorway = MailSurfaceDoorwayMetadataSchema.parse({
    accountId: account,
    mode: 'thread',
    source: 'mailbox',
    threadId: 'provider-thread-1',
  })
  assert.deepEqual(doorway, {
    accountId: account,
    mode: 'thread',
    source: 'mailbox',
    threadId: 'provider-thread-1',
  })
})

test('mail-surface doorway metadata rejects mail content and incompatible references', () => {
  const base = { accountId: account, mode: 'account', source: 'gmail' }
  for (const forbidden of [
    { subject: 'Private plan' },
    { snippet: 'Private preview' },
    { search: 'from:ceo' },
    { recipients: ['person@example.test'] },
    { body: 'Private message body' },
    { threadId: 'thread-1' },
  ]) {
    assert.equal(
      MailSurfaceDoorwayMetadataSchema.safeParse({ ...base, ...forbidden }).success,
      false,
    )
  }
})

test('mail-surface compose permits one structural provider reference', () => {
  assert.equal(
    MailSurfaceDoorwayMetadataSchema.safeParse({
      accountId: account,
      draftId: 'draft-1',
      mode: 'compose',
      source: 'gmail',
    }).success,
    true,
  )
  assert.equal(
    MailSurfaceDoorwayMetadataSchema.safeParse({
      accountId: account,
      draftId: 'draft-1',
      mode: 'compose',
      source: 'mailbox',
    }).success,
    false,
  )
})
