import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createNativeExternalAuthDeliveryQueue,
  mapExternalAuthSessionResult,
  nativeExternalAuthDeliveryScript,
} from './external-auth-delivery'

test('maps every Expo auth-session terminal result to a callback delivery', () => {
  assert.deepEqual(mapExternalAuthSessionResult({ type: 'success', url: 'nessie://auth/callback?code=x' }), {
    callbackUrl: 'nessie://auth/callback?code=x',
    kind: 'callback',
  })
  for (const type of ['cancel', 'dismiss']) {
    assert.deepEqual(mapExternalAuthSessionResult({ type }, 'pkce-state'), {
      callbackUrl: 'nessie://auth/callback?error=access_denied&state=pkce-state',
      kind: 'cancelled',
    })
  }
  assert.deepEqual(mapExternalAuthSessionResult({ type: 'locked' }, 'pkce-state'), {
    callbackUrl: 'nessie://auth/callback?error=native_auth_error&state=pkce-state',
    kind: 'error',
  })
})

test('native delivery queue survives handler timing and advances on receipt', () => {
  const queue = createNativeExternalAuthDeliveryQueue(2)
  const first = queue.enqueue('nessie://auth/callback?code=one')
  const second = queue.enqueue('nessie://auth/callback?code=two')
  assert.deepEqual(queue.head(), first)

  const script = nativeExternalAuthDeliveryScript(first)
  assert.match(script, /typeof w\.__nessieExternalAuthCallback!=='function'/)
  assert.match(script, /nessie:external-auth-delivered/)
  assert.doesNotMatch(script, /__nessiePendingExternalAuthCallbacks/)

  queue.acknowledge(first.id)
  assert.deepEqual(queue.head(), second)
  queue.acknowledge(second.id)
  assert.equal(queue.head(), null)
})

test('native delivery queue stays bounded across WebView reloads', () => {
  const queue = createNativeExternalAuthDeliveryQueue(2)
  queue.enqueue('one')
  const second = queue.enqueue('two')
  queue.enqueue('three')
  assert.deepEqual(queue.head(), second)
})
