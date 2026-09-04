import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { maskSecretValue } from '@nessie/schemas'

const readSource = (relativePath: string): string =>
  readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), 'utf8')

test('the capture form renders only a provider prefix and bullet mask', () => {
  const raw = ['github', 'pat', 'abcdefghijklmnopqrstuvwxyz0123456789', 'ABCD'].join('_')
  const masked = maskSecretValue(raw, 'github_token')

  assert.equal(masked, `github_pat_${'•'.repeat(12)}`)
  assert.doesNotMatch(masked, /abcdefghijklmnopqrstuvwxyz/)

  const dialog = readSource('../src/components/features/channels/SecretCaptureDialog.tsx')
  assert.match(dialog, /<Dialog/)
  assert.match(dialog, /value=\{maskSecretValue\(capture\.value, capture\.detected\.type\)\}/)
  assert.doesNotMatch(dialog, /value=\{capture\.value\}/)
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
