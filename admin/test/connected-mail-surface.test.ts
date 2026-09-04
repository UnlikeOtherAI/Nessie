import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { reviveMailComposeDraft } from '../src/components/features/connected-mail/ConnectedMailCompose.js'
import { mailPath } from '../src/facades/mail/hooks.js'
import { matchSurface } from '../src/navigation/surfaces.js'
import { readMailSurfaceDoorway } from '../src/components/features/channels/MailSurfaceDoorway.js'

const source = (relativePath: string): string =>
  readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), 'utf8')

test('connected mail routes are closed-source, explicit-account surfaces', () => {
  assert.equal(mailPath({ accountId: 'mailbox 1', source: 'mailbox' }), '/mail/mailbox/mailbox%201')
  assert.equal(matchSurface('/mail')?.surface.type, 'root')
  assert.equal(matchSurface('/mail/gmail/account/threads/thread')?.surface.type, 'nested')
  assert.equal(matchSurface('/mail/mailbox/account/compose')?.surface.type, 'flow')
  // Navigation stays generic so its totality check can classify dynamic router
  // samples; ConnectedMailPage itself rejects sources outside gmail|mailbox.
  assert.equal(matchSurface('/mail/unknown/account')?.surface.type, 'detail')
})

test('a compose draft cannot revive quoted provider material or an arbitrary From', () => {
  assert.deepEqual(reviveMailComposeDraft({ to: 'a@example.com', cc: '', bcc: '', subject: 'Hi', body: 'Hello' }), {
    to: 'a@example.com', cc: '', bcc: '', subject: 'Hi', body: 'Hello',
  })
  assert.deepEqual(reviveMailComposeDraft({ to: 'a@example.com', cc: '', bcc: '', subject: 'Hi', body: 'Hello', quote: 'private mail' }), {
    to: 'a@example.com', cc: '', bcc: '', subject: 'Hi', body: 'Hello',
  })
  assert.equal(reviveMailComposeDraft({ from: 'spoof@example.com', to: 'a@example.com' }), null)
})

test('mail doorway metadata accepts only identifiers and never content', () => {
  assert.deepEqual(readMailSurfaceDoorway({ mailSurfaceDoorway: { accountId: 'a', mode: 'thread', source: 'gmail', threadId: 't' } }), {
    accountId: 'a', mode: 'thread', source: 'gmail', threadId: 't',
  })
  assert.equal(readMailSurfaceDoorway({ mailSurfaceDoorway: { accountId: 'a', body: 'private', mode: 'account', source: 'gmail' } }), null)
  assert.equal(readMailSurfaceDoorway({ mailSurfaceDoorway: { accountId: 'a', draftId: 'd', mode: 'thread', source: 'gmail', threadId: 't' } }), null)
  assert.equal(readMailSurfaceDoorway({ mailSurfaceDoorway: { accountId: 'a', draftId: 'd', mode: 'compose', source: 'mailbox' } }), null)
})

test('the chat doorway uses session-only offer state and shared dialog navigation', () => {
  const doorway = source('../src/components/features/channels/MailSurfaceDoorway.tsx')
  assert.match(doorway, /sessionStorage/)
  assert.match(doorway, /<Dialog/)
  assert.match(doorway, /useConnectedMailAccounts/)
  assert.match(doorway, /MailSurfaceDoorwayMetadataSchema/)
  assert.match(doorway, /open && Boolean\(account\)/)
  assert.match(doorway, /accounts\.refetch\(\{ throwOnError: true \}\)/)
  assert.match(doorway, /removeItem\('mail-doorway-overlay-open'\)/)
  assert.doesNotMatch(doorway, /body:|recipients:|send:/)
})

test('compose and reply keep draft references structural and provider-owned', () => {
  const compose = source('../src/components/features/connected-mail/ConnectedMailCompose.tsx')
  const page = source('../src/pages/ConnectedMailPage.tsx')
  assert.match(compose, /useGmailDraft/)
  assert.match(compose, /gmailDraftId \? null : draftKey/)
  assert.match(compose, /useUpdateConnectedMailDraft/)
  assert.match(compose, /providerDraft\.data\.id !== gmailDraftId/)
  assert.match(compose, /Your email was sent/)
  assert.match(compose, /Your email is queued to send/)
  assert.match(page, /searchParams\.get\('draftId'\)/)
  assert.match(page, /threadId=.*reply=/)
  assert.doesNotMatch(page, /searchParams\.get\('query'\)/)
})
