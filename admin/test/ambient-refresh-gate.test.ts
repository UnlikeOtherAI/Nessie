import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createSessionMutationCoordinator,
  type SessionPayload,
} from '@nessie/client-core'

// Minimal localStorage stub so the persisted gate seam runs under node --test
// without a browser; mirrors admin/test/workflow-draft-storage.test.ts.
const store = new Map<string, string>()
;(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (key: string) => store.get(key) ?? null,
  removeItem: (key: string) => {
    store.delete(key)
  },
  setItem: (key: string, value: string) => {
    store.set(key, value)
  },
}

const {
  blockAmbientRefresh,
  isAmbientRefreshBlocked,
  unblockAmbientRefresh,
} = await import('../src/providers/ambient-refresh-gate')

const sessionPayload = (token: string): SessionPayload => ({
  me: {} as SessionPayload['me'],
  token,
})

// Mirrors the AuthSessionProvider wiring across a provider remount: each
// "mount" initializes its gate from the persisted marker and hands the
// ref-backed reader to a fresh coordinator generation; onTerminal sets the
// ref AND the persisted marker synchronously, and only a successfully applied
// explicit login clears both.
const createMountedProvider = (onRefresh?: () => Promise<SessionPayload | null>) => {
  let refreshCalls = 0
  const ambientRefreshBlocked = isAmbientRefreshBlocked()
  const gateRef = { current: ambientRefreshBlocked }
  const coordinator = createSessionMutationCoordinator({
    applySession: () => undefined,
    clearSession: () => undefined,
    isAmbientRefreshBlocked: () => gateRef.current,
    onTerminal: () => {
      blockAmbientRefresh()
      gateRef.current = true
    },
    refresh: () => {
      refreshCalls += 1
      return onRefresh?.() ?? Promise.resolve(sessionPayload('renewed-token'))
    },
  })
  const login = async (): Promise<void> => {
    await coordinator.run(async () => sessionPayload('login-token'))
    gateRef.current = false
    unblockAmbientRefresh()
  }
  return { coordinator, login, get refreshCalls() { return refreshCalls } }
}

test.beforeEach(() => {
  store.clear()
})

test('a failed logout terminal marker blocks all ambient refresh after a provider remount', async () => {
  // First mount: logout's server DELETE fails (swallowed) — the refresh
  // cookie family stays live, but the terminal notification still fires and
  // persists the fence.
  const first = createMountedProvider()
  // terminate's finally still fires onTerminal after the finalizer throws.
  await assert.rejects(
    first.coordinator.terminate(async () => {
      throw new Error('DELETE failed')
    }),
    /DELETE failed/,
  )
  assert.equal(isAmbientRefreshBlocked(), true)

  // A stale caller holding the retired generation's facade is refused.
  await assert.rejects(first.coordinator.refresh(), /ambient refresh is blocked/)
  assert.equal(first.refreshCalls, 0)

  // Remount: a fresh provider initializes blocked from the persisted marker,
  // so startup restore/proactive renewal/401 reconcile can never consume the
  // still-live refresh cookie — zero refresh calls after the remount.
  const remounted = createMountedProvider()
  await assert.rejects(remounted.coordinator.refresh(), /ambient refresh is blocked/)
  await assert.rejects(remounted.coordinator.reconcile(), /ambient refresh is blocked/)
  assert.equal(remounted.refreshCalls, 0)
})

test('a foreign-session terminal fence persists across a provider remount', async () => {
  const first = createMountedProvider()
  await assert.rejects(
    first.coordinator.runGuarded(
      async () => sessionPayload('foreign-token'),
      () => ({ kind: 'foreign', message: 'The renewed session is foreign.' }),
    ),
  )
  assert.equal(isAmbientRefreshBlocked(), true)

  const remounted = createMountedProvider()
  await assert.rejects(remounted.coordinator.refresh(), /ambient refresh is blocked/)
  assert.equal(remounted.refreshCalls, 0)
})

test('a successful explicit login after remount clears the marker and reopens ambient refresh', async () => {
  const first = createMountedProvider()
  await assert.rejects(
    first.coordinator.terminate(async () => {
      throw new Error('DELETE failed')
    }),
    /DELETE failed/,
  )

  const remounted = createMountedProvider()
  await assert.rejects(remounted.coordinator.refresh(), /ambient refresh is blocked/)

  // Explicit run is never gated: the login applies even while blocked, and
  // its successful apply clears the persisted marker.
  await remounted.login()
  assert.equal(isAmbientRefreshBlocked(), false)

  assert.equal(await remounted.coordinator.refresh(), 'renewed-token')
  assert.equal(remounted.refreshCalls, 1)

  // The next remount also starts unblocked: the fence cleared by the
  // explicit login does not outlive its session creation.
  const thirdMount = createMountedProvider()
  assert.equal(await thirdMount.coordinator.refresh(), 'renewed-token')
  assert.equal(thirdMount.refreshCalls, 1)
})

test('the persisted gate module alone: block survives a reload, unblock clears it', () => {
  assert.equal(isAmbientRefreshBlocked(), false)
  blockAmbientRefresh()
  assert.equal(isAmbientRefreshBlocked(), true)
  // Simulate a reload by re-reading straight from the storage stub.
  assert.equal(store.get('nessie.admin.ambient-refresh-blocked'), '1')
  unblockAmbientRefresh()
  assert.equal(isAmbientRefreshBlocked(), false)
  assert.equal(store.has('nessie.admin.ambient-refresh-blocked'), false)
})
