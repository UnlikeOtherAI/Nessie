import assert from 'node:assert/strict'
import test from 'node:test'

import { createNativeWebviewActions } from './native-webview-actions'

test('native tab and creation controls can dismiss every hosted transient menu', () => {
  const scripts: string[] = []
  const actions = createNativeWebviewActions((script) => scripts.push(script))

  actions.closeTransientMenus()

  assert.deepEqual(scripts, [
    'window.__nessieCloseTransientMenus && window.__nessieCloseTransientMenus();',
  ])
})

test('native focus control delegates to the hosted focus-mode action', () => {
  const scripts: string[] = []
  const actions = createNativeWebviewActions((script) => scripts.push(script))

  actions.toggleFocusMode()

  assert.deepEqual(scripts, [
    'window.__nessieToggleFocusMode && window.__nessieToggleFocusMode();',
  ])
})
