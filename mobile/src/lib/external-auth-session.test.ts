import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createNativeExternalAuthDeliveryQueue,
  mapExternalAuthSessionResult,
  nativeExternalAuthDeliveryScript,
} from './external-auth-delivery'

test('maps every Expo auth-session terminal result to an exact-state callback delivery', () => {
  assert.deepEqual(mapExternalAuthSessionResult(
    { type: 'success', url: 'nessie://auth/callback?code=x' },
    'pkce-state',
  ), {
    callbackUrl: 'nessie://auth/callback?code=x&state=pkce-state',
    kind: 'callback',
  })
  assert.equal(
    mapExternalAuthSessionResult(
      { type: 'success', url: 'nessie://auth/callback?code=x&state=provider-state' },
      'launch-state',
    ).callbackUrl,
    'nessie://auth/callback?code=x&state=provider-state',
  )
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

test('native delivery queue advances only after async SPA completion acknowledges it', async () => {
  const queue = createNativeExternalAuthDeliveryQueue(2)
  const first = queue.enqueue('nessie://auth/callback?code=one')
  const second = queue.enqueue('nessie://auth/callback?code=two')
  assert.deepEqual(queue.head(), first)

  const script = nativeExternalAuthDeliveryScript(first)
  assert.match(script, /typeof w\.__nessieExternalAuthCallback!=='function'/)
  assert.match(script, /nessie:external-auth-delivered/)
  assert.doesNotMatch(script, /__nessiePendingExternalAuthCallbacks/)

  const posted: string[] = []
  let finish: (() => void) | undefined
  const completion = new Promise<void>((resolve) => { finish = resolve })
  const nativeWindow = {
    ReactNativeWebView: { postMessage: (message: string) => posted.push(message) },
    __nessieExternalAuthCallback: () => completion,
  }
  Function('window', script)(nativeWindow)
  await Promise.resolve()
  assert.equal(posted.length, 0)
  assert.deepEqual(queue.head(), first)
  finish?.()
  await completion
  await Promise.resolve()
  assert.equal(posted.length, 1)

  queue.acknowledge(first.id)
  assert.deepEqual(queue.head(), second)
  queue.acknowledge(second.id)
  assert.equal(queue.head(), null)
})

test('native delivery remains queued when a WebView reload interrupts completion', async () => {
  const queue = createNativeExternalAuthDeliveryQueue()
  const delivery = queue.enqueue('nessie://auth/callback?code=one&state=s1')
  const script = nativeExternalAuthDeliveryScript(delivery)
  const posted: string[] = []
  Function('window', script)({
    ReactNativeWebView: { postMessage: (message: string) => posted.push(message) },
    __nessieExternalAuthCallback: () => Promise.reject(new Error('reload')),
  })
  await Promise.resolve()
  await Promise.resolve()
  assert.equal(posted.length, 0)
  assert.deepEqual(queue.head(), delivery)

  Function('window', script)({
    ReactNativeWebView: { postMessage: (message: string) => posted.push(message) },
    __nessieExternalAuthCallback: async () => undefined,
  })
  await Promise.resolve()
  await Promise.resolve()
  assert.equal(posted.length, 1)
})

test('native delivery queue stays bounded across WebView reloads', () => {
  const queue = createNativeExternalAuthDeliveryQueue(2)
  queue.enqueue('one')
  const second = queue.enqueue('two')
  queue.enqueue('three')
  assert.deepEqual(queue.head(), second)
})
