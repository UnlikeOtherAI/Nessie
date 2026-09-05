import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  reviveMailComposeDraft,
  validateMailComposeRecipients,
} from '../src/components/features/connected-mail/ConnectedMailCompose.js'
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

test('a local compose draft retains only its durable action identifiers across a reload', () => {
  assert.deepEqual(reviveMailComposeDraft({
    to: 'a@example.com', cc: '', bcc: '', subject: 'Hi', body: 'Hello',
    gmailDraftId: '00000000-0000-4000-8000-000000000001',
    mailboxSendActionId: '00000000-0000-4000-8000-000000000003',
    mailboxSendNeedsCheck: true,
    requestId: '00000000-0000-4000-8000-000000000002',
  }), {
    to: 'a@example.com', cc: '', bcc: '', subject: 'Hi', body: 'Hello',
    gmailDraftId: '00000000-0000-4000-8000-000000000001',
    mailboxSendActionId: '00000000-0000-4000-8000-000000000003',
    mailboxSendNeedsCheck: true,
    requestId: '00000000-0000-4000-8000-000000000002',
  })
  assert.deepEqual(reviveMailComposeDraft({
    to: 'a@example.com', cc: '', bcc: '', subject: 'Hi', body: 'Hello', requestId: 'not-an-id',
  }), { to: 'a@example.com', cc: '', bcc: '', subject: 'Hi', body: 'Hello' })
})

test('a held Gmail action survives reload so the owner can reconcile its outcome', () => {
  const sendAfter = new Date(Date.now() + 15_000).toISOString()
  assert.deepEqual(reviveMailComposeDraft({
    to: 'a@example.com', cc: '', bcc: '', subject: 'Hi', body: 'Hello',
    gmailHeldSend: { draftId: '00000000-0000-4000-8000-000000000004', sendAfter },
  })?.gmailHeldSend, { draftId: '00000000-0000-4000-8000-000000000004', sendAfter })
  assert.equal(reviveMailComposeDraft({
    to: 'a@example.com', cc: '', bcc: '', subject: 'Hi', body: 'Hello',
    gmailHeldSend: { draftId: 'not-an-id', sendAfter },
  })?.gmailHeldSend, undefined)
  assert.deepEqual(reviveMailComposeDraft({
    to: 'a@example.com', cc: '', bcc: '', subject: 'Hi', body: 'Hello',
    gmailHeldSend: { draftId: '00000000-0000-4000-8000-000000000004', sendAfter: '2020-01-01T00:00:00.000Z' },
  })?.gmailHeldSend, {
    draftId: '00000000-0000-4000-8000-000000000004', sendAfter: '2020-01-01T00:00:00.000Z',
  })
})

test('recipient fields reuse the shared envelope schema before a send mutation', () => {
  assert.deepEqual(validateMailComposeRecipients({
    to: 'Casey <casey@acme.example>', cc: '', bcc: 'copy@example.com', subject: 'Hi', body: 'Hello',
  }), { to: 'Recipients must be bare email addresses.' })
  assert.deepEqual(validateMailComposeRecipients({
    to: 'casey@acme.example', cc: 'bad address', bcc: '', subject: 'Hi', body: 'Hello',
  }), { cc: 'Recipients must be bare email addresses.' })
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
  // The entitlement recheck goes through the accounts query's throwing refetch,
  // held as a stable handle so the offer effect is not restarted by every
  // account-list change (react-hooks/exhaustive-deps).
  assert.match(doorway, /const refetchAccounts = accounts\.refetch/)
  assert.match(doorway, /refetchAccounts\(\{ throwOnError: true \}\)/)
  // Which doorway owns the overlay is module state, not sessionStorage: a
  // reload does not run effect cleanup, so a stored marker outlived it and
  // disabled auto-open for the rest of the tab. The per-message "offered"
  // record is still sessionStorage — that one is meant to survive a reload.
  assert.match(doorway, /let openDoorwayMessageId: string \| null = null/)
  assert.match(doorway, /openDoorwayMessageId === messageId\) openDoorwayMessageId = null/)
  assert.doesNotMatch(doorway, /'mail-doorway-overlay-open'/)
  assert.match(doorway, /sessionStorage\.setItem\(storageKey/)
  assert.match(doorway, /ownsOverlayMarkerRef/)
  // The account list is only fetched for a message that actually carries a
  // doorway; the chip mounts on every row in the feed.
  assert.match(doorway, /useConnectedMailAccounts\(Boolean\(doorway\)\)/)
  // A compose doorway naming a thread is a reply, and must carry the reply
  // target into both the inline composer and the full-mail hand-off.
  assert.match(doorway, /replyTo=\{replyTo\}/)
  assert.match(doorway, /doorwayPath\(doorway, replyTo\?\.id\)/)
  assert.match(doorway, /<MailboxWorkspace/)
  assert.match(doorway, /<MailboxThreadList/)
  assert.match(doorway, /doorway\.mode === 'compose' \? account\.canCompose : account\.canRead/)
  assert.match(doorway, /size=\{layout === 'single' \? 'full' : 'xl'\}/)
  assert.doesNotMatch(doorway, /body:|recipients:|send:/)
})

test('compose and reply keep draft references structural and provider-owned', () => {
  const compose = source('../src/components/features/connected-mail/ConnectedMailCompose.tsx')
  const page = source('../src/pages/ConnectedMailPage.tsx')
  assert.match(compose, /useGmailDraft/)
  assert.match(compose, /activeGmailDraftId \? null : draftKey/)
  assert.match(compose, /useUpdateConnectedMailDraft/)
  assert.match(compose, /inReplyTo: replyTo\?\.messageId \?\? undefined/)
  assert.match(compose, /providerDraft\.data\.id !== activeGmailDraftId/)
  assert.match(compose, /editedProviderDraftRef\.current/)
  assert.match(compose, /useAuthSession/)
  assert.match(compose, /\$\{me\.user\.id\}:\$\{me\.context\.organizationId\}/)
  assert.match(compose, /providerDraftRef\.current/)
  assert.match(compose, /Persist the action key before crossing the network boundary/)
  assert.match(compose, /mailboxSendActionId/)
  assert.match(compose, /mailboxSendNeedsCheck/)
  assert.match(compose, /Editing must not mint a fresh send identity/)
  assert.match(compose, /mailbox-delivery-unknown/)
  assert.match(compose, /Check the provider’s Sent mail/)
  assert.match(compose, /deriveMailSendOutcome/)
  assert.match(compose, /mailboxSendLocked/)
  const outcomeModel = source('../src/components/features/connected-mail/mail-send-outcome.ts')
  const mailHooks = source('../src/facades/mail/hooks.ts')
  assert.match(outcomeModel, /mailboxAction\?\.state === 'dispatching'/)
  assert.match(outcomeModel, /gmailAction\?\.state === 'dispatching'/)
  assert.match(mailHooks, /await queryClient\.cancelQueries/)
  assert.match(mailHooks, /gmailKeys\.draftStatus\(input\.draftId\)/)
  assert.match(mailHooks, /sendAfter: data\.sendAfter, state: 'sending'/)
  assert.match(mailHooks, /refetchInterval/)
  assert.match(mailHooks, /state === 'dispatching'/)
  assert.doesNotMatch(compose, /mailboxAction\.refetch\(\)/)
  assert.match(compose, /gmailDraftId: gmailAction\.id/)
  assert.doesNotMatch(compose, /createIdempotencyKeyRef|mailboxSendIdempotencyKeyRef/)
  assert.match(compose, /Create a new Gmail draft/)
  assert.match(compose, /undoGmailSend/)
  assert.match(compose, /gmailHeldSend/)
  assert.match(compose, /useGmailDraftStatus/)
  assert.match(compose, /heldGmailSend\?\.draftId \?\? activeGmailDraftId/)
  assert.match(compose, /if \(!newCompose \|\| consumedNewComposeRef\.current\) return/)
  assert.match(compose, /onNewComposeReady\?\.\(\)/)
  assert.match(page, /const completeNewCompose = useCallback/)
  assert.match(compose, /gmailActionLocked/)
  assert.match(compose, /GmailSendOutcomePanel/)
  assert.match(compose, /deriveMailSendOutcome/)
  assert.match(compose, /validateMailComposeRecipients/)
  assert.match(compose, /ConnectedMailComposeInputSchema\.safeParse/)
  assert.match(compose, /<MailField error=\{recipientErrors\.to\}/)
  assert.match(compose, /const draftId = sent\?\.id \?\? heldGmailSend\?\.draftId/)
  assert.match(compose, /setActiveGmailDraftId\(draftId\)/)
  assert.match(compose, /if \(activeGmailDraftId\)/)
  assert.match(compose, /await providerDraft\.refetch\(\)/)
  assert.match(compose, /!account\.canSend/)
  const outcome = source('../src/components/features/connected-mail/GmailSendOutcomePanel.tsx')
  assert.match(outcome, /Your email was sent/)
  assert.match(outcome, /Your email is queued to send/)
  assert.match(outcome, /Your draft is being restored/)
  assert.match(outcome, /This draft update could not be confirmed/)
  assert.match(outcome, /outcome\.kind === 'queued'/)
  assert.match(outcome, /I checked Sent — start a new email/)
  assert.match(page, /searchParams\.get\('draftId'\)/)
  assert.match(page, /threadId=.*reply=/)
  assert.doesNotMatch(page, /searchParams\.get\('query'\)/)
  assert.match(page, /Search phrases are provider content/)
  assert.match(page, /Items per page/)
  assert.match(page, /Mail account/)
  assert.match(page, /flowOwnsBack=\{layout === 'single' && Boolean\(threadId\)\}/)
})

test('mail content queries never retain a prior account, thread, or draft', () => {
  const mailHooks = source('../src/facades/mail/hooks.ts')
  const gmailHooks = source('../src/facades/gmail/hooks.ts')

  assert.doesNotMatch(mailHooks, /keepPreviousData/)
  assert.doesNotMatch(gmailHooks, /keepPreviousData/)
})

test('unavailable account rows name their remedy instead of offering a dead-end control', () => {
  const page = source('../src/pages/ConnectedMailPage.tsx')

  assert.match(page, /ConnectedMailAccountRow/)
  assert.match(page, /!account\.canRead \? <p/)
  assert.match(page, /Open mailbox settings/)
  assert.match(page, /connectedMailSettingsPath\(account\)/)
  assert.match(page, /!account\.canCompose/)
})
