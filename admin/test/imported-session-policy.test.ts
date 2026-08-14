import assert from 'node:assert/strict'
import test from 'node:test'
import {
  canUseRefreshCookie,
  clearSessionIfCurrent,
  createImportedSessionApplyTracker,
  finalizeSessionLogout,
  isSessionCredentialCurrent,
  resolveSessionRefreshAction,
  resolveTerminatingSessionCredential,
} from '../src/lib/imported-session-policy'

test('import application tracking is ref-counted for overlapping identical tokens', () => {
  const tracker = createImportedSessionApplyTracker()
  tracker.add('same-token')
  tracker.add('same-token')

  tracker.delete('same-token')
  assert.equal(tracker.has('same-token'), true)
  tracker.delete('same-token')
  assert.equal(tracker.has('same-token'), false)
})

test('only the matching renewable session generation may use the refresh cookie', () => {
  assert.equal(canUseRefreshCookie({
    currentImportedToken: null,
    currentToken: 'renewable-token',
    expected: { mode: 'renewable', token: 'renewable-token' },
  }), true)
  assert.equal(canUseRefreshCookie({
    currentImportedToken: 'imported-token',
    currentToken: 'imported-token',
    expected: { mode: 'imported', token: 'imported-token' },
  }), false)
  assert.equal(canUseRefreshCookie({
    currentImportedToken: null,
    currentToken: null,
    expected: { mode: 'imported', token: 'stale-imported-token' },
  }), false)
  assert.equal(canUseRefreshCookie({
    currentImportedToken: null,
    currentToken: 'replacement-token',
    expected: { mode: 'renewable', token: 'stale-token' },
  }), false)
})

test('a stale renewable 401 cannot clear a replacement imported session', () => {
  assert.equal(resolveSessionRefreshAction({
    currentImportedToken: 'new-imported-token',
    currentToken: 'new-imported-token',
    expected: { mode: 'renewable', token: 'old-renewable-token' },
    importInFlight: false,
  }), 'none')

  assert.equal(resolveSessionRefreshAction({
    currentImportedToken: 'new-imported-token',
    currentToken: 'new-imported-token',
    expected: { mode: 'imported', token: 'new-imported-token' },
    importInFlight: false,
  }), 'clear-imported')
})

test('an unauthenticated client cannot join an in-flight import as a refresh', () => {
  assert.equal(resolveSessionRefreshAction({
    currentImportedToken: null,
    currentToken: null,
    expected: { mode: 'renewable', token: null },
    importInFlight: true,
  }), 'none')

  assert.equal(resolveSessionRefreshAction({
    currentImportedToken: null,
    currentToken: null,
    expected: { mode: 'renewable', token: null },
    importInFlight: false,
  }), 'refresh')
})

test('an imported restore retry expires with its credential generation', () => {
  assert.equal(isSessionCredentialCurrent({
    currentImportedToken: 'imported-token',
    currentToken: 'imported-token',
    expected: { mode: 'imported', token: 'imported-token' },
  }), true)
  assert.equal(isSessionCredentialCurrent({
    currentImportedToken: null,
    currentToken: null,
    expected: { mode: 'imported', token: 'imported-token' },
  }), false)
  assert.equal(isSessionCredentialCurrent({
    currentImportedToken: 'replacement-import',
    currentToken: 'replacement-import',
    expected: { mode: 'renewable', token: null },
  }), false)
})

test('an imported clear cannot erase a replacement session applied during query cancellation', async () => {
  let currentToken: string | null = 'imported-token'
  let committed = false
  const cleared = await clearSessionIfCurrent({
    clearQueries: async () => {
      currentToken = 'replacement-token'
    },
    commit: () => {
      committed = true
      currentToken = null
    },
    expectedToken: 'imported-token',
    readCurrentToken: () => currentToken,
  })

  assert.equal(cleared, false)
  assert.equal(committed, false)
  assert.equal(currentToken, 'replacement-token')
})

test('an imported logout is local-only while renewable native logout unregisters then revokes', async () => {
  const importedActions: string[] = []
  await finalizeSessionLogout({
    mode: 'imported',
    nativeWebView: true,
    revokeRemoteSession: async () => { importedActions.push('revoke') },
    unregisterNativePush: async () => { importedActions.push('unregister') },
  })
  assert.deepEqual(importedActions, [])

  const renewableActions: string[] = []
  await finalizeSessionLogout({
    mode: 'renewable',
    nativeWebView: true,
    revokeRemoteSession: async () => { renewableActions.push('revoke') },
    unregisterNativePush: async () => { renewableActions.push('unregister') },
  })
  assert.deepEqual(renewableActions, ['unregister', 'revoke'])
})

test('logout keeps imported ownership when expiry clears refs during termination', () => {
  assert.deepEqual(resolveTerminatingSessionCredential({
    initiating: { mode: 'imported', token: 'expiring-import' },
    pendingImportedTokens: [],
    terminalToken: null,
  }), { mode: 'imported', token: 'expiring-import' })

  assert.deepEqual(resolveTerminatingSessionCredential({
    initiating: { mode: 'renewable', token: null },
    pendingImportedTokens: ['pending-import'],
    terminalToken: 'pending-import',
  }), { mode: 'imported', token: 'pending-import' })

  assert.deepEqual(resolveTerminatingSessionCredential({
    initiating: { mode: 'renewable', token: 'old-token' },
    pendingImportedTokens: ['different-import'],
    terminalToken: 'renewed-token',
  }), { mode: 'renewable', token: 'renewed-token' })
})
