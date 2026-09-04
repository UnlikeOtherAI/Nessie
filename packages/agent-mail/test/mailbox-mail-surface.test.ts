import assert from 'node:assert/strict'
import test from 'node:test'

import { mailboxThreadToken } from '../src/mailbox-client.js'
import { parseMailboxThreadToken } from '../src/mailbox-thread-token.js'
import {
  mailboxHeaderWindow,
  nativeThreadHeaderUids,
  validateMailboxThreadMembers,
} from '../src/mailbox-mail-surface.js'
import { parseThreadReferenceSets } from '../src/imap.js'

test('structural IMAP thread token is stable across refetches and processes', () => {
  const first = mailboxThreadToken({
    accountId: 'account-1', folder: 'INBOX', rootMessageId: 'root@example.test', uid: 4, uidValidity: 10,
  })
  const refetched = mailboxThreadToken({
    accountId: 'account-1', folder: 'INBOX', rootMessageId: 'root@example.test', uid: 99, uidValidity: 11,
  })
  assert.equal(first, refetched)
})

test('unthreaded IMAP token changes when UIDVALIDITY changes', () => {
  const beforeReset = mailboxThreadToken({
    accountId: 'account-1', folder: 'INBOX', rootMessageId: null, uid: 4, uidValidity: 10,
  })
  const afterReset = mailboxThreadToken({
    accountId: 'account-1', folder: 'INBOX', rootMessageId: null, uid: 4, uidValidity: 11,
  })
  assert.notEqual(beforeReset, afterReset)
})

test('listed IMAP tokens carry a bounded UIDVALIDITY-validated seed', () => {
  const token = mailboxThreadToken({
    accountId: 'account-1', folder: 'INBOX', memberUids: [13, 11, 12], messageCount: 3,
    rootMessageId: 'root@example.test', uid: 13, uidValidity: 10,
  })
  assert.deepEqual(parseMailboxThreadToken(token), {
    accountId: 'account-1', folder: 'INBOX', memberUids: [13, 12, 11], messageCount: 3,
    rootDigest: parseMailboxThreadToken(token)?.rootDigest,
    seedUid: 13, uidValidity: 10,
  })
  assert.equal(parseMailboxThreadToken(mailboxThreadToken({
    accountId: 'account-1', folder: 'INBOX', rootMessageId: null, uid: 13, uidValidity: 10,
  })), null)
})

test('a thread token cannot add unrelated mailbox UIDs after its headers are validated', () => {
  const token = mailboxThreadToken({
    accountId: 'account-1', folder: 'INBOX', memberUids: [8, 7, 99], messageCount: 3,
    rootMessageId: 'root@example.test', uid: 8, uidValidity: 10,
  })
  const parsed = parseMailboxThreadToken(token)
  assert.ok(parsed)
  const members = validateMailboxThreadMembers(parsed, [
    {
      date: null, from: null, fromName: null, hasAttachments: false, inReplyTo: null,
      messageId: 'root@example.test', references: [], snippet: '', subject: 'Root', to: [], uid: 7, unread: false,
    },
    {
      date: null, from: null, fromName: null, hasAttachments: false, inReplyTo: 'root@example.test',
      messageId: 'reply@example.test', references: ['root@example.test'], snippet: '', subject: 'Reply', to: [], uid: 8, unread: false,
    },
    {
      date: null, from: null, fromName: null, hasAttachments: false, inReplyTo: null,
      messageId: 'unrelated@example.test', references: [], snippet: '', subject: 'Other', to: [], uid: 99, unread: false,
    },
  ])
  assert.deepEqual(members?.map((member) => member.uid), [8, 7])
  const wrongRoot = Buffer.from(JSON.stringify({
    ...JSON.parse(Buffer.from(token, 'base64url').toString('utf8')),
    r: 'not-the-structural-root',
  })).toString('base64url')
  const wrongRootToken = parseMailboxThreadToken(wrongRoot)
  assert.ok(wrongRootToken)
  assert.equal(validateMailboxThreadMembers(wrongRootToken, []), null)
})

test('THREAD=REFERENCES parser emits only flattened top-level groups', () => {
  assert.deepEqual(parseThreadReferenceSets('* THREAD (1 2 (3 4))(5 (6))'), [
    [1, 2, 3, 4],
    [5, 6],
  ])
})

test('fallback paging advances to a bounded older UID header window', () => {
  const uids = Array.from({ length: 101 }, (_, index) => 101 - index)
  assert.deepEqual(mailboxHeaderWindow(uids, 100), [1])
})

test('native THREAD paging reserves one newest header for every group', () => {
  const groups = Array.from({ length: 100 }, (_, index) => [index * 2 + 1, index * 2 + 2])
  const uids = nativeThreadHeaderUids(groups)
  assert.equal(uids.length, 100)
  assert.deepEqual(uids, groups.map((group) => group[1]))
})
