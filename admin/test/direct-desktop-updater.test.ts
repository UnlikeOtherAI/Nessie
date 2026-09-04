import assert from 'node:assert/strict'
import test from 'node:test'

import {
  checkForDirectDesktopUpdate,
  remindAboutDirectDesktopUpdateLater,
  skipDirectDesktopUpdate,
} from '../src/lib/direct-desktop-updater.js'

test('web and store builds never invoke the direct desktop updater', async () => {
  await checkForDirectDesktopUpdate()
})

test('a direct desktop build delegates preferences to native app data', async () => {
  const calls: Array<{ args: unknown; command: string }> = []
  const originalWindow = globalThis.window
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      __nessieDirectUpdater: true,
      __TAURI_INTERNALS__: {
        invoke: async (command: string, args: unknown) => {
          calls.push({ args, command })
          if (command === 'desktop_direct_update_check') {
            return { body: null, currentVersion: '0.1.0', version: '0.1.1' }
          }
          return undefined
        },
      },
    },
  })
  try {
    assert.deepEqual(await checkForDirectDesktopUpdate(), {
      body: null,
      currentVersion: '0.1.0',
      version: '0.1.1',
    })
    await skipDirectDesktopUpdate('0.1.1')
    await remindAboutDirectDesktopUpdateLater('0.1.1')
    assert.deepEqual(calls, [
      { args: {}, command: 'desktop_direct_update_check' },
      { args: { version: '0.1.1' }, command: 'desktop_direct_update_skip' },
      { args: { version: '0.1.1' }, command: 'desktop_direct_update_remind' },
    ])
  } finally {
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: originalWindow,
    })
  }
})
