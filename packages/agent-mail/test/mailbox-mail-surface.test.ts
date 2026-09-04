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
import { imapAttachmentParts, parseImapBodyStructure } from '../src/imap-bodystructure.js'

const ACCOUNT_ID = 'account-1'
const FOLDER = 'INBOX'
const SECRET = 'mail-thread-token-secret'

const token = (input: Omit<Parameters<typeof mailboxThreadToken>[0], 'accountId' | 'folder'>): string =>
  mailboxThreadToken({ ...input, accountId: ACCOUNT_ID, folder: FOLDER }, SECRET)

const parse = (value: string) => parseMailboxThreadToken(value, {
  accountId: ACCOUNT_ID, folder: FOLDER, secret: SECRET,
})

test('signed IMAP thread tokens bind their account, folder, and listed members', () => {
  const value = token({
    memberUids: [13, 11, 12], messageCount: 3, rootMessageId: 'root@example.test', uid: 13, uidValidity: 10,
  })
  assert.deepEqual(parse(value), {
    accountId: ACCOUNT_ID, folder: FOLDER, memberUids: [13, 12, 11], messageCount: 3,
    rootDigest: parse(value)?.rootDigest, seedUid: 13, uidValidity: 10,
  })
  assert.equal(parseMailboxThreadToken(value, {
    accountId: 'another-account', folder: FOLDER, secret: SECRET,
  }), null)
})

test('IMAP thread tokens stay under the public parameter limit for bounded large groups', () => {
  const value = token({
    memberUids: Array.from({ length: 50 }, (_, index) => 4_294_967_295 - index * 80_000_000),
    messageCount: 500, rootMessageId: 'root@example.test', uid: 4_294_967_295, uidValidity: 4_294_967_295,
  })
  assert.ok(value.length <= 500, value)
  assert.equal(parse(value)?.memberUids.length, 50)
})

test('IMAP thread tokens reject tampering and unthreaded roots do not collide', () => {
  const first = token({ memberUids: [8], messageCount: 1, rootMessageId: null, uid: 8, uidValidity: 10 })
  const second = token({ memberUids: [9], messageCount: 1, rootMessageId: null, uid: 9, uidValidity: 10 })
  assert.notEqual(first, second)
  const tampered = `${first.slice(0, -1)}${first.endsWith('A') ? 'B' : 'A'}`
  assert.equal(parse(tampered), null)
})

test('a thread token cannot add unrelated mailbox UIDs after its headers are validated', () => {
  const parsed = parse(token({
    memberUids: [8, 7, 99], messageCount: 3, rootMessageId: 'root@example.test', uid: 8, uidValidity: 10,
  }))
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
  ], SECRET)
  assert.deepEqual(members?.map((member) => member.uid), [8, 7])
})

test('thread-token validation refuses a missing seed group', () => {
  const parsed = parse(token({
    memberUids: [8], messageCount: 1, rootMessageId: 'root@example.test', uid: 8, uidValidity: 10,
  }))
  assert.ok(parsed)
  assert.equal(validateMailboxThreadMembers(parsed, [], SECRET), null)
})

test('THREAD=REFERENCES parser emits only flattened top-level groups', () => {
  assert.deepEqual(parseThreadReferenceSets('* THREAD (1 2 (3 4))(5 (6))'), [[1, 2, 3, 4], [5, 6]])
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

test('list attachment markers use BODYSTRUCTURE metadata, not attachment payloads', () => {
  const parts = parseImapBodyStructure(
    '* 1 FETCH (UID 1 BODYSTRUCTURE (("TEXT" "PLAIN" ("CHARSET" "UTF-8") NIL NIL "7BIT" 4 1 NIL NIL NIL)("APPLICATION" "ZIP" ("NAME" "archive.zip") NIL NIL "BASE64" 50000000 NIL ("ATTACHMENT" ("FILENAME" "archive.zip")) NIL NIL) "MIXED"))',
  )
  assert.equal(parts.length, 2)
  assert.deepEqual(imapAttachmentParts(parts), [{
    bytes: 50_000_000, charset: null, contentType: 'application/zip', encoding: 'BASE64',
    filename: 'archive.zip', section: '2', textKind: null,
  }])
})

test('a top-level text message uses the RFC 3501 TEXT section', () => {
  assert.deepEqual(parseImapBodyStructure(
    '* 1 FETCH (UID 1 BODYSTRUCTURE ("TEXT" "PLAIN" ("CHARSET" "UTF-8") NIL NIL "7BIT" 4 1 NIL NIL NIL))',
  ).map((part) => part.section), ['TEXT'])
})
