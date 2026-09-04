import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { maskSecretValue } from '@nessie/schemas'
import {
  advanceSecretCapture,
  createSecretCapture,
  protectedReplacement,
} from '../src/components/features/channels/secret-capture.js'
import { reviveComposerDraft } from '../src/components/features/channels/composer-draft.js'

const readSource = (relativePath: string): string =>
  readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), 'utf8')

test('the capture form renders only a provider prefix and bullet mask', () => {
  const raw = ['github', 'pat', 'abcdefghijklmnopqrstuvwxyz0123456789', 'ABCD'].join('_')
  const masked = maskSecretValue(raw, 'github_token')

  assert.equal(masked, `github_pat_${'•'.repeat(12)}`)
  assert.doesNotMatch(masked, /abcdefghijklmnopqrstuvwxyz/)

  const dialog = readSource('../src/components/features/channels/SecretCaptureDialog.tsx')
  assert.match(dialog, /<Dialog/)
  assert.match(dialog, /value=\{maskSecretValue\(item\.value, item\.detected\.type\)\}/)
  assert.doesNotMatch(dialog, /value=\{item\.value\}/)
})

test('multiple credentials are queued and only protected text is rebuilt', () => {
  const stripe = ['sk', 'live', '1234567890abcdefghijklmnop'].join('_')
  const github = `ghp_${'a'.repeat(36)}`
  const capture = createSecretCapture({ content: `Use ${stripe} and ${github}` })

  assert.ok(capture)
  assert.equal(capture.items.length, 2)
  const second = advanceSecretCapture(capture, 'STRIPE_API_KEY')
  assert.ok(second)
  const replacement = protectedReplacement(second, 'GITHUB_TOKEN')
  assert.doesNotMatch(replacement, /1234567890|a{20}/)
  assert.match(replacement, /STRIPE_API_KEY, GITHUB_TOKEN/)
  assert.match(replacement, /^\[Secrets protected/)
  assert.equal(second.currentIndex, 1)
})

test('the form explains valid names and partial multi-secret discard behavior', () => {
  const dialog = readSource('../src/components/features/channels/SecretCaptureDialog.tsx')

  assert.match(dialog, /Use uppercase letters, numbers, and underscores/)
  assert.match(dialog, /earlier \{savedSubject\} already saved/)
  assert.match(dialog, /will not send this message/)
})

test('every channel composer doorway owns the same capture form', () => {
  const callSites = [
    '../src/pages/channels/ThreadInboxCard.tsx',
    '../src/pages/channels/ChannelConversationSurface.tsx',
    '../src/components/features/channels/ChannelAgentInfoDrawer.tsx',
    '../src/components/features/channels/ChannelUserInfoDrawer.tsx',
    '../src/components/features/channels/thread-panel/ThreadReplyPanel.tsx',
  ]

  for (const callSite of callSites) {
    const source = readSource(callSite)
    assert.match(source, /secretCapture=\{(?:composer\.)?secretCapture\}/, callSite)
    assert.match(
      source,
      /onConfirmSecretCapture=\{(?:composer\.)?confirmSecretCapture\}/,
      callSite,
    )
    assert.match(
      source,
      /onDismissSecretCapture=\{(?:composer\.)?dismissSecretCapture\}/,
      callSite,
    )
  }
})

test('new conversations and message edits use the protected capture flow', () => {
  const newConversationPage = readSource('../src/pages/ChannelConversationComposePage.tsx')
  const newConversationSend = readSource(
    '../src/pages/channels/useNewChannelConversationSend.ts',
  )
  const messageActions = readSource(
    '../src/components/features/channels/useChannelMessageActions.tsx',
  )
  const secretHooks = readSource('../src/facades/secrets/hooks.ts')
  const transientHook = secretHooks.slice(
    secretHooks.indexOf('export const useTransientSecretSave'),
    secretHooks.indexOf('export const useRevokeSecret'),
  )

  assert.match(newConversationPage, /<SecretCaptureDialog/)
  assert.match(newConversationSend, /createSecretCapture/)
  assert.match(newConversationSend, /replacementMode: content\.length .* \? 'file' : 'message'/s)
  assert.match(newConversationSend, /useUploadAttachment/)
  assert.match(messageActions, /createSecretCapture/)
  assert.match(messageActions, /<SecretCaptureDialog/)
  assert.match(transientHook, /useCallback\(async/)
  assert.doesNotMatch(transientHook, /useMutation/)
})

test('settings and agent-card credential writes never retain variables in mutation caches', () => {
  const settings = readSource('../src/pages/settings/SecretsPage.tsx')
  const cardHooks = readSource('../src/facades/agent-cards/hooks.ts')
  const messageHooks = readSource('../src/facades/messages/hooks.ts')
  const uploadHook = messageHooks.slice(
    messageHooks.indexOf('export const useUploadAttachment'),
    messageHooks.indexOf('export const useDiscardAttachment'),
  )

  assert.match(settings, /useTransientSecretSave/)
  assert.doesNotMatch(settings, /useCreateSecret/)
  assert.doesNotMatch(cardHooks, /useMutation/)
  assert.match(uploadHook, /useCallback\(async/)
  assert.doesNotMatch(uploadHook, /useMutation/)
})

test('editing a failed secret form rotates its idempotency key', () => {
  const captureDialog = readSource(
    '../src/components/features/channels/SecretCaptureDialog.tsx',
  )
  const settingsDialog = readSource(
    '../src/components/features/settings/CreateSecretDialog.tsx',
  )

  assert.match(captureDialog, /const updateName = .*newCaptureRequestId\(\)/s)
  assert.match(captureDialog, /const updateScopeType = .*newCaptureRequestId\(\)/s)
  assert.match(settingsDialog, /const changed = .*newCaptureId\(\)/s)
})

test('failed protected sends remain open and retry without saving the value twice', () => {
  const dialog = readSource('../src/components/features/channels/SecretCaptureDialog.tsx')
  const composer = readSource(
    '../src/components/features/channels/useChannelComposer.ts',
  )
  const messageActions = readSource(
    '../src/components/features/channels/useChannelMessageActions.tsx',
  )
  const updateStart = messageActions.indexOf('await updateMessage({')
  const closeAfterUpdate = messageActions.indexOf('storePendingSecretEdit(null)', updateStart)
  const protectedSendStart = composer.indexOf('const confirmSecretCapture')
  const safePost = composer.indexOf('await postSafeText(', protectedSendStart)
  const closeAfterPost = composer.indexOf('storeSecretCapture(null)', safePost)

  assert.match(dialog, /const \[savedSecret, setSavedSecret\]/)
  assert.match(dialog, /savedSecret \? 'Retry protected message'/)
  assert.ok(updateStart >= 0)
  assert.ok(closeAfterUpdate > updateStart)
  assert.ok(safePost > protectedSendStart)
  assert.ok(closeAfterPost > safePost)
})

test('a detected composer secret flushes its safe replacement to draft storage immediately', () => {
  const composer = readSource(
    '../src/components/features/channels/useChannelComposer.ts',
  )

  assert.match(composer, /setDraft\(\(current\) => \(\{ \.\.\.current, text: '' \}\)\)/)
  assert.match(composer, /void flushDraft\(\)/)
})

test('an oversize file send intercepts a credential-bearing accompanying draft', () => {
  const composer = readSource(
    '../src/components/features/channels/useChannelComposer.ts',
  )
  const newConversationSend = readSource(
    '../src/pages/channels/useNewChannelConversationSend.ts',
  )

  assert.match(composer, /clearComposer: false,[\s\S]*content: paste/)
  assert.match(composer, /accompanyingText && captureSecretText/)
  assert.match(newConversationSend, /const accompanyingCapture = createSecretCapture/)
  assert.match(newConversationSend, /storeSecretCapture\(accompanyingCapture\)/)
  const capturePaste = newConversationSend.slice(
    newConversationSend.indexOf('const captureOversizePaste'),
    newConversationSend.indexOf('const confirmSecretCapture'),
  )
  assert.doesNotMatch(capturePaste, /clearComposer\(\)/)
})

test('credential-bearing legacy composer drafts are refused during hydration', () => {
  const secret = `sk-proj-${'aB3_'.repeat(8)}`
  assert.equal(reviveComposerDraft({ attachments: [], text: secret }), null)
})

test('credential-bearing legacy attachment filenames are refused during hydration', () => {
  const secret = `sk-proj-${'aB3_'.repeat(8)}`
  assert.equal(reviveComposerDraft({
    attachments: [{
      attachmentId: 'attachment-1',
      clientId: 'client-1',
      filename: `notes-${secret}.txt`,
      sizeBytes: 10,
    }],
    text: '',
  }), null)
})
