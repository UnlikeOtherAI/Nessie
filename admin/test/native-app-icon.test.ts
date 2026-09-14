import assert from 'node:assert/strict'
import { afterEach, beforeEach, test } from 'node:test'

import {
  isNativeAppIconShell,
  readNativeAppIcon,
  requestNativeAppIcon,
} from '../src/facades/native-app-icon.js'

const globalWindow = globalThis as { window?: unknown }
// The admin suite runs every test file in one process, and other files leave a
// `window` of their own in place (tenant-host-branding.test.ts stubs one when
// it loads). Put back whatever was there just before each test instead of
// deleting it; reading it at import time would miss a stub installed by a file
// that loads after this one.
let originalWindow: PropertyDescriptor | undefined

beforeEach(() => {
  originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
})

afterEach(() => {
  if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow)
  else delete globalWindow.window
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

test('reads the icon the shell reports, defaulting to dark', () => {
  globalWindow.window = {}
  assert.equal(readNativeAppIcon(), 'dark')
  globalWindow.window = { __nessieNativeAppIcon: 'light' }
  assert.equal(readNativeAppIcon(), 'light')
  globalWindow.window = { __nessieNativeAppIcon: 'AppIconLight' }
  assert.equal(readNativeAppIcon(), 'dark')
})

test('asks the shell for the chosen icon over the bridge', () => {
  const posted: string[] = []
  globalWindow.window = { ReactNativeWebView: { postMessage: (data: string) => posted.push(data) } }

  requestNativeAppIcon('dark')

  assert.deepEqual(posted.map((data) => JSON.parse(data)), [{ type: 'nessie:app-icon', icon: 'dark' }])
})
