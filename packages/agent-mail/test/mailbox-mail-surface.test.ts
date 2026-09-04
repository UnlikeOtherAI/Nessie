import assert from 'node:assert/strict'
import test from 'node:test'

import { mailboxThreadToken } from '../src/mailbox-client.js'
import { parseMailboxThreadToken } from '../src/mailbox-thread-token.js'
import {
  mailboxHeaderWindow,
  boundedThreadDetailUids,
  discoverRelatedThreadUids,
  nativeThreadHeaderUids,
  nativeThreadSeedUids,
  validateMailboxThreadMembers,
} from '../src/mailbox-mail-surface.js'
import { uidWindowEndingAt, withinUidWindow } from '../src/imap-uid-window.js'
import { parseThreadReferenceSets, type ImapPart, type ImapSession } from '../src/imap.js'
import { imapAttachmentParts, parseImapBodyStructure } from '../src/imap-bodystructure.js'

const ACCOUNT_ID = 'account-1'
const FOLDER = 'INBOX'
const SECRET = 'mail-thread-token-secret'

const token = (input: Omit<Parameters<typeof mailboxThreadToken>[0], 'accountId' | 'folder'>): string =>
  mailboxThreadToken({ ...input, accountId: ACCOUNT_ID, folder: FOLDER }, SECRET)

const parse = (value: string) => parseMailboxThreadToken(value, {
  accountId: ACCOUNT_ID, folder: FOLDER, secret: SECRET,
})

test('signed IMAP thread tokens bind their account, folder, UIDVALIDITY, root, and stable seed', () => {
  const value = token({
    rootMessageId: 'root@example.test', uid: 11, uidValidity: 10,
  })
  assert.deepEqual(parse(value), {
    accountId: ACCOUNT_ID, folder: FOLDER,
    rootDigest: parse(value)?.rootDigest, seedUid: 11, uidValidity: 10,
  })
  assert.equal(parseMailboxThreadToken(value, {
    accountId: 'another-account', folder: FOLDER, secret: SECRET,
  }), null)
})

test('IMAP thread tokens stay under the public parameter limit without group membership', () => {
  const value = token({
    rootMessageId: 'root@example.test', uid: 4_294_967_295, uidValidity: 4_294_967_295,
  })
  assert.ok(value.length <= 500, value)
})

test('IMAP thread tokens reject tampering and unthreaded roots do not collide', () => {
  const first = token({ rootMessageId: null, uid: 8, uidValidity: 10 })
  const second = token({ rootMessageId: null, uid: 9, uidValidity: 10 })
  assert.notEqual(first, second)
  const tampered = `${first.slice(0, -1)}${first.endsWith('A') ? 'B' : 'A'}`
  assert.equal(parse(tampered), null)
})

test('a thread token authenticates the re-derived group and excludes unrelated mailbox UIDs', () => {
  const parsed = parse(token({
    rootMessageId: 'root@example.test', uid: 7, uidValidity: 10,
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
    rootMessageId: 'root@example.test', uid: 8, uidValidity: 10,
  }))
  assert.ok(parsed)
  assert.equal(validateMailboxThreadMembers(parsed, [], SECRET), null)
})

test('a logical thread keeps its public id after a new reply arrives', () => {
  const beforeReply = token({ rootMessageId: 'root@example.test', uid: 7, uidValidity: 10 })
  const parsed = parse(beforeReply)
  assert.ok(parsed)
  const root = {
    date: null, from: null, fromName: null, hasAttachments: false, inReplyTo: null,
    messageId: 'root@example.test', references: [], snippet: '', subject: 'Root', to: [], uid: 7, unread: false,
  }
  const reply = {
    ...root, inReplyTo: 'root@example.test', messageId: 'reply@example.test',
    references: ['root@example.test'], subject: 'Reply', uid: 8,
  }
  assert.deepEqual(validateMailboxThreadMembers(parsed, [root], SECRET)?.map((member) => member.uid), [7])
  assert.deepEqual(validateMailboxThreadMembers(parsed, [root, reply], SECRET)?.map((member) => member.uid), [8, 7])
  assert.equal(beforeReply, token({ rootMessageId: 'root@example.test', uid: 7, uidValidity: 10 }))
})

test('THREAD=REFERENCES parser emits only flattened top-level groups', () => {
  assert.deepEqual(parseThreadReferenceSets('* THREAD (1 2 (3 4))(5 (6))'), [[1, 2, 3, 4], [5, 6]])
})

test('fallback paging advances to a bounded older UID header window', () => {
  const uids = Array.from({ length: 101 }, (_, index) => 101 - index)
  assert.deepEqual(mailboxHeaderWindow(uids, 100), [1])
})

test('thread discovery scopes every broad IMAP criteria to one UID window', () => {
  const window = uidWindowEndingAt(1_000)
  assert.deepEqual(window, { lower: 901, upper: 1_000 })
  assert.deepEqual(withinUidWindow(['ALL'], window!), ['UID 901:1000'])
  assert.deepEqual(withinUidWindow(['UNSEEN', ' TEXT ', { literal: 'invoice' }], window!), [
    'UID 901:1000', ' ', 'UNSEEN', ' TEXT ', { literal: 'invoice' },
  ])
})

test('a signed visible reply seed authenticates through its structural root', () => {
  const parsed = parse(token({ rootMessageId: 'root@example.test', uid: 8, uidValidity: 10 }))
  assert.ok(parsed)
  const reply = {
    date: null, from: null, fromName: null, hasAttachments: false,
    inReplyTo: 'root@example.test', messageId: 'reply@example.test',
    references: ['root@example.test'], snippet: '', subject: 'Reply', to: [], uid: 8, unread: false,
  }
  const newerReply = { ...reply, messageId: 'newer@example.test', uid: 9 }
  const members = validateMailboxThreadMembers(parsed, [reply, newerReply], SECRET)
  assert.deepEqual(members?.map((member) => member.uid), [9, 8])
})

test('related-thread discovery caps a huge mailbox without an unbounded search response', async () => {
  const requests: ImapPart[][] = []
  const session = {
    searchUids: async (criteria: ImapPart[]) => {
      requests.push(criteria)
      return Array.from({ length: 100 }, (_, index) => 1_000_000 - requests.length * 100 - index)
    },
  } as unknown as ImapSession
  const discovered = await discoverRelatedThreadUids(session, 'root@example.test', 1_000_001)
  assert.equal(discovered.capped, true)
  assert.equal(discovered.uids.length, 500)
  assert.equal(requests.length, 5)
  assert.equal(requests[0]?.[0], 'UID 999901:1000000')
  assert.ok(requests.every((criteria) => !criteria.includes('ALL')))
})

test('related-thread discovery includes an older root when the signed seed is its reply', async () => {
  const requests: ImapPart[][] = []
  const session = {
    searchUids: async (criteria: ImapPart[]) => {
      requests.push(criteria)
      // A root does not reference itself; this is the reply seed plus the
      // older root that only HEADER MESSAGE-ID can discover.
      return criteria.includes('OR HEADER MESSAGE-ID ') ? [900, 899] : [900]
    },
  } as unknown as ImapSession
  const discovered = await discoverRelatedThreadUids(session, 'root@example.test', 10_001)

  assert.deepEqual(discovered, { capped: true, uids: [900, 899] })
  assert.deepEqual(requests[0], [
    'UID 9901:10000', ' ', 'OR HEADER MESSAGE-ID ', { literal: 'root@example.test' },
    ' OR HEADER REFERENCES ', { literal: 'root@example.test' },
    ' HEADER IN-REPLY-TO ', { literal: 'root@example.test' },
  ])
})

test('native THREAD paging reserves one newest header for every group', () => {
  const groups = Array.from({ length: 100 }, (_, index) => [index * 2 + 1, index * 2 + 2])
  const uids = nativeThreadHeaderUids(groups)
  assert.equal(uids.length, 100)
  assert.deepEqual(uids, groups.map((group) => group[1]))
})

test('100 native groups retain their complete bounded detail independently of summary headers', () => {
  const groups = Array.from({ length: 100 }, (_, index) => [index * 2 + 1, index * 2 + 2])
  assert.deepEqual(nativeThreadSeedUids(groups), groups.map((group) => group[0]))
  assert.equal(nativeThreadHeaderUids(groups).length, 100)
  assert.deepEqual(boundedThreadDetailUids(groups[42] ?? [], groups[42]?.[0] ?? 0), [86, 85])
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

test('BODYSTRUCTURE rejects excessive nesting and part counts', () => {
  const leaf = '("TEXT" "PLAIN" NIL NIL NIL "7BIT" 1 1 NIL NIL NIL)'
  const nested = Array.from({ length: 33 }).reduce((value) => `(${value} "MIXED")`, leaf)
  const many = `(${Array.from({ length: 101 }, () => leaf).join(' ')} "MIXED")`
  assert.deepEqual(parseImapBodyStructure(`* 1 FETCH (UID 1 BODYSTRUCTURE ${nested})`), [])
  assert.deepEqual(parseImapBodyStructure(`* 1 FETCH (UID 1 BODYSTRUCTURE ${many})`), [])
})
