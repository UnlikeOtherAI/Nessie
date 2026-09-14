import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'

import {
  isNativeAppIconShell,
  readNativeAppIcon,
  requestNativeAppIcon,
} from '../src/facades/native-app-icon.js'

const globalWindow = globalThis as { window?: unknown }

afterEach(() => {
  delete globalWindow.window
})

test('the app icon choice is offered only when the shell says it can switch', () => {
  assert.equal(isNativeAppIconShell(), false)

  globalWindow.window = { ReactNativeWebView: { postMessage: () => undefined } }
  assert.equal(isNativeAppIconShell(), false)

  globalWindow.window = {
    ReactNativeWebView: { postMessage: () => undefined },
    __nessieNativeShell: { appIcon: true },
  }
  assert.equal(isNativeAppIconShell(), true)

  // A desktop or browser page that happens to carry the shell global is not the phone.
  globalWindow.window = { __nessieNativeShell: { appIcon: true } }
  assert.equal(isNativeAppIconShell(), false)
})

test('reads the icon the shell reports, defaulting to light', () => {
  globalWindow.window = {}
  assert.equal(readNativeAppIcon(), 'light')
  globalWindow.window = { __nessieNativeAppIcon: 'dark' }
  assert.equal(readNativeAppIcon(), 'dark')
  globalWindow.window = { __nessieNativeAppIcon: 'AppIconDark' }
  assert.equal(readNativeAppIcon(), 'light')
})

test('asks the shell for the chosen icon over the bridge', () => {
  const posted: string[] = []
  globalWindow.window = { ReactNativeWebView: { postMessage: (data: string) => posted.push(data) } }

  requestNativeAppIcon('dark')

  assert.deepEqual(posted.map((data) => JSON.parse(data)), [{ type: 'nessie:app-icon', icon: 'dark' }])
})
