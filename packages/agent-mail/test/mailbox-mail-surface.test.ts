import assert from 'node:assert/strict'
import test from 'node:test'

import { mailboxThreadToken } from '../src/mailbox-client.js'
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

test('THREAD=REFERENCES parser emits only flattened top-level groups', () => {
  assert.deepEqual(parseThreadReferenceSets('* THREAD (1 2 (3 4))(5 (6))'), [
    [1, 2, 3, 4],
    [5, 6],
  ])
})
