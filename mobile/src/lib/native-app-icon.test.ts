import assert from 'node:assert/strict'
import test from 'node:test'

import { isAppIconMessage, NATIVE_APP_ICON_EVENT, nativeAppIconScript } from './native-app-icon'

class TestCustomEvent {
  constructor(readonly type: string, readonly init: { detail?: unknown }) {}
}

test('publishes the icon in effect on window and as an event', () => {
  const events: TestCustomEvent[] = []
  const window: Record<string, unknown> = {
    dispatchEvent: (event: TestCustomEvent) => { events.push(event) },
  }

  new Function('window', 'CustomEvent', nativeAppIconScript('dark'))(window, TestCustomEvent)

  assert.equal(window.__nessieNativeAppIcon, 'dark')
  assert.equal(events.length, 1)
  assert.equal(events[0]?.type, NATIVE_APP_ICON_EVENT)
  assert.equal(events[0]?.init.detail, 'dark')
})

test('accepts only the two shipped icons', () => {
  assert.equal(isAppIconMessage({ type: 'nessie:app-icon', icon: 'light' }), true)
  assert.equal(isAppIconMessage({ type: 'nessie:app-icon', icon: 'dark' }), true)
  assert.equal(isAppIconMessage({ type: 'nessie:app-icon', icon: 'AppIconLight' }), false)
  assert.equal(isAppIconMessage({ type: 'nessie:haptic', icon: 'dark' }), false)
})
