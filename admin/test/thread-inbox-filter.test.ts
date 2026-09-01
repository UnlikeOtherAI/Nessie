import assert from 'node:assert/strict'
import test from 'node:test'

import {
  readThreadInboxUnreadOnly,
  THREADS_UNREAD_ONLY_STORAGE_KEY,
  writeThreadInboxUnreadOnly,
} from '../src/pages/thread-inbox-filter.js'

const createStorage = () => {
  const values = new Map<string, string>()
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  }
}

test('persists the Threads unread-only choice in device-local storage', () => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  const storage = createStorage()
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { localStorage: storage },
  })

  try {
    assert.equal(readThreadInboxUnreadOnly(), false)

    writeThreadInboxUnreadOnly(true)
    assert.equal(storage.getItem(THREADS_UNREAD_ONLY_STORAGE_KEY), 'true')
    assert.equal(readThreadInboxUnreadOnly(), true)

    writeThreadInboxUnreadOnly(false)
    assert.equal(readThreadInboxUnreadOnly(), false)
  } finally {
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow)
    else Reflect.deleteProperty(globalThis, 'window')
  }
})
