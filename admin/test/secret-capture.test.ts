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
  assert.equal(second.currentIndex, 1)
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
  const newConversation = readSource('../src/pages/ChannelConversationComposePage.tsx')
  const messageActions = readSource(
    '../src/components/features/channels/useChannelMessageActions.tsx',
  )
  const secretHooks = readSource('../src/facades/secrets/hooks.ts')
  const transientHook = secretHooks.slice(
    secretHooks.indexOf('export const useTransientSecretSave'),
    secretHooks.indexOf('export const useRevokeSecret'),
  )

  for (const source of [newConversation, messageActions]) {
    assert.match(source, /createSecretCapture/)
    assert.match(source, /<SecretCaptureDialog/)
  }
  assert.match(transientHook, /useCallback\(async/)
  assert.doesNotMatch(transientHook, /useMutation/)
})
