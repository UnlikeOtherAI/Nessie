import assert from 'node:assert/strict'
import test from 'node:test'
import {
  NATIVE_CLEANUP_LOGOUT_TIMEOUT_MS,
  performTerminalSessionLogout,
} from '../src/providers/terminal-session-logout.js'

const deferred = (): {
  promise: Promise<void>
  reject: (error: Error) => void
  resolve: () => void
} => {
  let reject!: (error: Error) => void
  let resolve!: () => void
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    reject = rejectPromise
    resolve = resolvePromise
  })
  return { promise, reject, resolve }
}

test('starts native unregister before terminate and does not delay local clear', async () => {
  const native = deferred()
  const events: string[] = []
  const logoutBearers: Array<string | null> = []

  const result = performTerminalSessionLogout({
    currentBearer: 'captured-bearer',
    isNative: true,
    unregisterNative: () => {
      events.push('native-start')
      return native.promise
    },
    terminate: async (finalize) => {
      events.push('terminate')
      events.push('local-clear')
      await finalize(null)
    },
    logout: async (bearer) => {
      events.push('logout')
      logoutBearers.push(bearer)
    },
  })

  assert.deepEqual(events, ['native-start', 'terminate', 'local-clear'])
  assert.deepEqual(logoutBearers, [])

  native.resolve()
  await result

  assert.deepEqual(events, ['native-start', 'terminate', 'local-clear', 'logout'])
  assert.deepEqual(logoutBearers, ['captured-bearer'])
})

test('a rejected native unregister still calls logout', async () => {
  const native = deferred()
  const logoutBearers: Array<string | null> = []

  const result = performTerminalSessionLogout({
    currentBearer: 'captured-bearer',
    isNative: true,
    unregisterNative: () => native.promise,
    terminate: async (finalize) => finalize(null),
    logout: async (bearer) => { logoutBearers.push(bearer) },
  })

  native.reject(new Error('native bridge failed'))
  await result

  assert.deepEqual(logoutBearers, ['captured-bearer'])
})

test('a never-settling native unregister cannot block remote logout', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const events: string[] = []

  const result = performTerminalSessionLogout({
    currentBearer: 'captured-bearer',
    isNative: true,
    unregisterNative: () => new Promise(() => undefined),
    terminate: async (finalize) => {
      events.push('terminate')
      events.push('local-clear')
      await finalize(null)
    },
    logout: async () => { events.push('logout') },
  })

  assert.deepEqual(events, ['terminate', 'local-clear'])

  t.mock.timers.tick(NATIVE_CLEANUP_LOGOUT_TIMEOUT_MS - 1)
  await Promise.resolve()
  assert.deepEqual(events, ['terminate', 'local-clear'])

  t.mock.timers.tick(1)
  await result

  assert.deepEqual(events, ['terminate', 'local-clear', 'logout'])
})

test('the latest winning payload overrides the bearer captured at logout start', async () => {
  const logoutBearers: Array<string | null> = []

  await performTerminalSessionLogout({
    currentBearer: 'old-bearer',
    isNative: false,
    unregisterNative: async () => {
      throw new Error('must not run outside the native shell')
    },
    terminate: async (finalize) => finalize({ token: 'winning-bearer' }),
    logout: async (bearer) => { logoutBearers.push(bearer) },
  })

  assert.deepEqual(logoutBearers, ['winning-bearer'])
})
