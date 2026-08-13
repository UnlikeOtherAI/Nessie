import assert from 'node:assert/strict'
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

test('native presentation normalizes badge counts and preserves an authoritative total', () => {
  const message = {
    type: 'nessie:attention',
    assignedWork: 2.8,
    channels: -1,
    knowledge: 3,
    total: 9,
  }
  const next = reduceNativeShellPresentation(DEFAULT_NATIVE_SHELL_PRESENTATION, message)
  assert.deepEqual(next.attentionBadges, { assignedWork: 2, channels: 0, knowledge: 3 })
  assert.equal(nativeAttentionTotal(message), 9)
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
