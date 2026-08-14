import assert from 'node:assert/strict'
import test from 'node:test'

import {
  nativePhoneTabBarClearanceScript,
  nativePushPathScript,
  nativeShellInfoScript,
} from './native-shell'

type NativeEvent = {
  detail?: unknown
  type: string
}

class TestEvent {
  constructor(readonly type: string) {}
}

class TestCustomEvent extends TestEvent {
  constructor(type: string, readonly init: { detail?: unknown }) {
    super(type)
  }

  get detail(): unknown {
    return this.init.detail
  }
}

const runShellScript = (
  script: string,
  configure?: (window: Record<string, unknown>) => void,
): { events: NativeEvent[]; window: Record<string, unknown> } => {
  const events: NativeEvent[] = []
  const window: Record<string, unknown> = {
    dispatchEvent: (event: NativeEvent): void => {
      events.push(event)
    },
  }
  configure?.(window)
  const execute = new Function('window', 'Event', 'CustomEvent', script)
  execute(window, TestEvent, TestCustomEvent)
  return { events, window }
}

test('caches a cold-start push path before the WebView application mounts', () => {
  const { events, window } = runShellScript(nativeShellInfoScript({
    bottomInset: 34,
    clientId: 'client-id',
    formFactor: 'phone',
    pendingPushPath: '/channels/channel-a/threads/thread-a/replies/root-a',
    platform: 'ios',
  }))

  assert.equal(window.__nessiePendingPushPath, '/channels/channel-a/threads/thread-a/replies/root-a')
  assert.deepEqual(window.__nessieNativeShell, { bottomInset: 34, formFactor: 'phone', platform: 'ios' })
  assert.equal(events.at(-1)?.type, 'nessie:native-push-path')
  assert.equal(events.at(-1)?.detail, '/channels/channel-a/threads/thread-a/replies/root-a')
})

test('updates the iPhone WebView clearance when its safe-area inset changes', () => {
  const values = new Map<string, string>()
  const document = {
    documentElement: {
      style: {
        setProperty: (name: string, value: string): void => {
          values.set(name, value)
        },
      },
    },
  }
  const execute = new Function('document', nativePhoneTabBarClearanceScript(34))

  execute(document)

  assert.equal(values.get('--nessie-native-phone-tabbar-clearance'), '83px')
})

test('retains a new push target until the React bridge acknowledges it', () => {
  const { events, window } = runShellScript(nativePushPathScript('/channels/channel-b'))

  assert.equal(window.__nessiePendingPushPath, '/channels/channel-b')
  assert.equal(events[0]?.type, 'nessie:native-push-path')
  assert.equal(events[0]?.detail, '/channels/channel-b')

  const clear = new Function('window', nativePushPathScript(null))
  clear(window)
  assert.equal('__nessiePendingPushPath' in window, false)
})

test('routes a warm notification tap through the mounted SPA navigator immediately', () => {
  const navigated: unknown[] = []
  const path = '/channels/channel-c/threads/thread-c/replies/root-c'

  runShellScript(nativePushPathScript(path), (window) => {
    window.__nessieNavigate = (target: unknown): void => {
      navigated.push(target)
    }
  })

  assert.deepEqual(navigated, [path])
})
