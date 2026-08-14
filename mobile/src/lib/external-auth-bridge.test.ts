import assert from 'node:assert/strict'
import test from 'node:test'

import {
  NATIVE_EXTERNAL_AUTH_EVENT,
  nativeExternalAuthResultScript,
  runExternalAuthSession,
  type NativeExternalAuthResult,
} from './external-auth-bridge'

type NativeEvent = {
  detail?: unknown
  type: string
}

class TestCustomEvent {
  readonly detail: unknown

  constructor(readonly type: string, init: { detail?: unknown }) {
    this.detail = init.detail
  }
}

const publishResult = (result: NativeExternalAuthResult): {
  callbacks: string[]
  events: NativeEvent[]
} => {
  const callbacks: string[] = []
  const events: NativeEvent[] = []
  const window = {
    __nessieExternalAuthCallback: (url: string): void => {
      callbacks.push(url)
    },
    dispatchEvent: (event: NativeEvent): void => {
      events.push(event)
    },
  }
  const execute = new Function('window', 'CustomEvent', nativeExternalAuthResultScript(result))
  execute(window, TestCustomEvent)
  return { callbacks, events }
}

test('closing or dismissing the native auth sheet becomes a cancellation', async () => {
  for (const type of ['cancel', 'dismiss']) {
    const result = await runExternalAuthSession(
      'https://sso.example/authorize',
      'nessie://auth/callback',
      async () => ({ type }),
    )
    assert.deepEqual(result, { type: 'cancelled' })
  }
})

test('successful native auth preserves the exact callback URL', async () => {
  const url = 'nessie://auth/callback?code=code-1&state=state-1'
  const result = await runExternalAuthSession(
    'https://sso.example/authorize',
    'nessie://auth/callback',
    async () => ({ type: 'success', url }),
  )

  assert.deepEqual(result, { type: 'success', url })
  const published = publishResult(result)
  assert.deepEqual(published.callbacks, [url])
  assert.equal(published.events[0]?.type, NATIVE_EXTERNAL_AUTH_EVENT)
  assert.deepEqual(published.events[0]?.detail, result)
})

test('cancellation is published even though it has no callback URL', () => {
  const result: NativeExternalAuthResult = { type: 'cancelled' }
  const published = publishResult(result)

  assert.deepEqual(published.callbacks, [])
  assert.equal(published.events[0]?.type, NATIVE_EXTERNAL_AUTH_EVENT)
  assert.deepEqual(published.events[0]?.detail, result)
})

test('native browser failures publish an actionable terminal result', async () => {
  const result = await runExternalAuthSession(
    'https://sso.example/authorize',
    'nessie://auth/callback',
    async () => {
      throw new Error('native session unavailable')
    },
  )

  assert.deepEqual(result, {
    message: 'Unable to open the sign-in window. Please try again.',
    type: 'failed',
  })
  assert.deepEqual(publishResult(result).events[0]?.detail, result)
})

test('non-terminal or malformed browser results become retryable failures', async () => {
  for (const browserResult of [
    { type: 'locked' },
    { type: 'opened' },
    { type: 'success' },
  ]) {
    const result = await runExternalAuthSession(
      'https://sso.example/authorize',
      'nessie://auth/callback',
      async () => browserResult,
    )

    assert.deepEqual(result, {
      message: 'Unable to open the sign-in window. Please try again.',
      type: 'failed',
    })
  }
})
