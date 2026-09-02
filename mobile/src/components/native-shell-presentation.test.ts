import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import {
  DEFAULT_NATIVE_SHELL_PRESENTATION,
  isNativeShellPresentationMessage,
  nativeAttentionTotal,
  reduceNativeShellPresentation,
} from './native-shell-presentation'

test('native workspace presentation carries its public picture and clears invalid values', () => {
  const withWorkspace = reduceNativeShellPresentation(DEFAULT_NATIVE_SHELL_PRESENTATION, {
    type: 'nessie:workspace',
    name: 'Design',
    workspaceAvatarUrl: 'https://authentication.example/teams/design/avatar',
  })
  assert.equal(withWorkspace.workspaceName, 'Design')
  assert.equal(
    withWorkspace.workspaceAvatarUrl,
    'https://authentication.example/teams/design/avatar',
  )

  const cleared = reduceNativeShellPresentation(withWorkspace, {
    type: 'nessie:workspace',
    name: ' ',
    workspaceAvatarUrl: '',
  })
  assert.equal(cleared.workspaceName, null)
  assert.equal(cleared.workspaceAvatarUrl, null)
})

test('native presentation normalizes per-section badge counts and sums an authoritative total', () => {
  const message = {
    type: 'nessie:attention',
    badges: { channels: 2.8, projects: -1, knowledge: 3, admin: 1 },
  }
  const next = reduceNativeShellPresentation(DEFAULT_NATIVE_SHELL_PRESENTATION, message)
  assert.deepEqual(next.attentionBadges, { channels: 2, projects: 0, knowledge: 3, admin: 1, search: 0 })
  assert.equal(nativeAttentionTotal(message), 6)
})

// The admin does not post `nessie:attention` for every section yet — a
// missing `badges` object, and any section it omits, both read as 0 rather
// than being dropped or crashing the reducer.
test('native presentation defaults every section to 0 when badges is absent or incomplete', () => {
  const withoutBadges = reduceNativeShellPresentation(DEFAULT_NATIVE_SHELL_PRESENTATION, {
    type: 'nessie:attention',
  })
  assert.deepEqual(withoutBadges.attentionBadges, { channels: 0, projects: 0, knowledge: 0, admin: 0, search: 0 })
  assert.equal(nativeAttentionTotal({ type: 'nessie:attention' }), 0)

  const partial = reduceNativeShellPresentation(DEFAULT_NATIVE_SHELL_PRESENTATION, {
    type: 'nessie:attention',
    badges: { channels: 5 },
  })
  assert.deepEqual(partial.attentionBadges, { channels: 5, projects: 0, knowledge: 0, admin: 0, search: 0 })
})

test('native account focus mode is preserved from the web shell', () => {
  const focused = reduceNativeShellPresentation(DEFAULT_NATIVE_SHELL_PRESENTATION, {
    type: 'nessie:account',
    userFocusMode: true,
    userPresence: 'online',
  })

  assert.equal(focused.nativeAccount.focusModeEnabled, true)
  assert.equal(focused.nativeAccount.presence, 'online')
})

test('only presentation messages enter the native presentation reducer', () => {
  assert.equal(isNativeShellPresentationMessage({ type: 'theme' }), true)
  assert.equal(isNativeShellPresentationMessage({ type: 'nessie:workspace' }), true)
  assert.equal(isNativeShellPresentationMessage({ type: 'nessie:route' }), false)
  assert.equal(
    reduceNativeShellPresentation(DEFAULT_NATIVE_SHELL_PRESENTATION, { type: 'nessie:route' }),
    DEFAULT_NATIVE_SHELL_PRESENTATION,
  )
})

test('the WebView leaves pull-to-refresh to the admin page', () => {
  const source = readFileSync(new URL('./MobileAdminWebView.tsx', import.meta.url), 'utf8')
  assert.match(source, /pullToRefreshEnabled=\{false\}/)
})
