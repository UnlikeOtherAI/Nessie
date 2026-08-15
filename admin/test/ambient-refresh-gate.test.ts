import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createSessionMutationCoordinator,
  type SessionPayload,
} from '@nessie/client-core'

// Minimal localStorage stub so the persisted gate seam runs under node --test
// without a browser; mirrors admin/test/workflow-draft-storage.test.ts.
const store = new Map<string, string>()
let throwOnRead = false
let throwOnWrite = false
;(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (key: string) => {
    if (throwOnRead) throw new Error('storage read denied')
    return store.get(key) ?? null
  },
  removeItem: (key: string) => {
    if (throwOnWrite) throw new Error('storage write denied')
    store.delete(key)
  },
  setItem: (key: string, value: string) => {
    if (throwOnWrite) throw new Error('storage write denied')
    store.set(key, value)
  },
}

const {
  blockAmbientRefresh,
  isAmbientRefreshBlocked,
  unblockAmbientRefresh,
} = await import('../src/providers/ambient-refresh-gate')
const { createAmbientRefreshGateHost } = await import(
  '../src/providers/ambient-refresh-gate-host'
)

const sessionPayload = (token: string): SessionPayload => ({
  me: {} as SessionPayload['me'],
  token,
})

// Mirrors the AuthSessionProvider wiring across a provider remount: each
// "mount" builds a fresh gate host that initializes its ref from the
// persisted marker and hands the ref-backed reader to a fresh coordinator
// generation; the coordinator's onTerminalStart hook sets the ref AND the
// persisted marker synchronously at terminal begin, and only a successfully
// applied explicit login reopens both.
const createMountedProvider = (input?: {
  onForeignSession?: () => Promise<void>
  onRefresh?: () => Promise<SessionPayload | null>
}) => {
  let refreshCalls = 0
  const gate = createAmbientRefreshGateHost()
  const coordinator = createSessionMutationCoordinator({
    applySession: () => undefined,
    clearSession: () => undefined,
    isAmbientRefreshBlocked: gate.isBlocked,
    onForeignSession: input?.onForeignSession,
    onTerminal: gate.onTerminal,
    onTerminalStart: gate.onTerminalStart,
    refresh: () => {
      refreshCalls += 1
      return input?.onRefresh?.() ?? Promise.resolve(sessionPayload('renewed-token'))
    },
  })
  const login = async (): Promise<void> => {
    await coordinator.run(async () => sessionPayload('login-token'))
    gate.reopen()
  }
  return { coordinator, login, get refreshCalls() { return refreshCalls } }
}

test.beforeEach(() => {
  store.clear()
  throwOnRead = false
  throwOnWrite = false
})

test('the marker exists at terminate begin: a remount during a stalled DELETE makes zero refresh calls', async () => {
  // The actual race: logout's server DELETE is still in flight (stalled or
  // failing slowly) when the page, Tauri window, or mobile WebView reloads.
  // The post-terminal notification has NOT fired yet — only the synchronous
  // terminal-start hook may have persisted the fence.
  const first = createMountedProvider()
  let finalizerBegan!: () => void
  let settleFinalizer!: () => void
  const began = new Promise<void>((resolve) => {
    finalizerBegan = resolve
  })
  const termination = first.coordinator.terminate(
    () => {
      finalizerBegan()
      return new Promise<void>((resolve) => {
        settleFinalizer = resolve
      })
    },
  )
  // Without awaiting terminate: the persisted marker must ALREADY exist,
  // before the finalizer is allowed to settle.
  assert.equal(isAmbientRefreshBlocked(), true)
  assert.equal(store.get('nessie.admin.ambient-refresh-blocked'), '1')
  // Deterministic: hold until the stalled DELETE is actually in flight —
  // the marker was persisted before it even started.
  await began

  // Simulate the remount while the DELETE is still pending: a fresh provider
  // sharing the same storage initializes blocked from the marker, so its
  // startup restore/proactive renewal/401 reconcile can never consume the
  // still-live refresh cookie — zero refresh calls.
  const remounted = createMountedProvider()
  await assert.rejects(remounted.coordinator.refresh(), /ambient refresh is blocked/)
  await assert.rejects(remounted.coordinator.reconcile(), /ambient refresh is blocked/)
  assert.equal(remounted.refreshCalls, 0)

  // Only now let the finalizer settle; a stale caller holding the retired
  // generation's facade stays refused after completion too.
  settleFinalizer()
  await termination
  await assert.rejects(first.coordinator.refresh(), /ambient refresh is blocked/)
  assert.equal(first.refreshCalls, 0)
  assert.equal(remounted.refreshCalls, 0)
})

test('a failed logout terminal marker blocks all ambient refresh after a provider remount', async () => {
  // First mount: logout's server DELETE fails (swallowed) — the refresh
  // cookie family stays live, but the terminal completion still fires.
  const first = createMountedProvider()
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

test('a peer mounted before logout dynamically observes the persisted terminal marker', async () => {
  const first = createMountedProvider()
  const alreadyMountedPeer = createMountedProvider()

  await first.coordinator.terminate(async () => undefined)

  await assert.rejects(
    alreadyMountedPeer.coordinator.refresh(),
    /ambient refresh is blocked/,
  )
  await assert.rejects(
    alreadyMountedPeer.coordinator.reconcile(),
    /ambient refresh is blocked/,
  )
  assert.equal(alreadyMountedPeer.refreshCalls, 0)
})

test('the marker exists at foreign-fence begin: a remount during a stalled revocation makes zero refresh calls', async () => {
  // The analogous foreign-fence timing, deterministic: the fence's
  // caller-owned revocation is deliberately left pending when the remount
  // happens.
  let revocationBegan!: () => void
  let settleRevocation!: () => void
  const began = new Promise<void>((resolve) => {
    revocationBegan = resolve
  })
  const first = createMountedProvider({
    onForeignSession: () => {
      revocationBegan()
      return new Promise<void>((resolve) => {
        settleRevocation = resolve
      })
    },
  })
  const fenced = first.coordinator.runGuarded(
    async () => sessionPayload('foreign-token'),
    () => ({ kind: 'foreign', message: 'The renewed session is foreign.' }),
  )
  // Wait until the revocation is actually in flight, then prove the fence
  // was already persisted before that awaited work began.
  await began
  assert.equal(isAmbientRefreshBlocked(), true)
  assert.equal(store.get('nessie.admin.ambient-refresh-blocked'), '1')

  const remounted = createMountedProvider()
  await assert.rejects(remounted.coordinator.refresh(), /ambient refresh is blocked/)
  await assert.rejects(remounted.coordinator.reconcile(), /ambient refresh is blocked/)
  assert.equal(remounted.refreshCalls, 0)

  settleRevocation()
  await assert.rejects(fenced, /foreign/)
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

test('denied storage never defeats the in-memory terminal gate', () => {
  const host = createAmbientRefreshGateHost()
  throwOnWrite = true

  assert.doesNotThrow(host.onTerminalStart)
  assert.equal(host.ref.current, true)
  assert.equal(host.isBlocked(), true)

  assert.doesNotThrow(host.reopen)
  assert.equal(host.ref.current, false)
  throwOnRead = true
  assert.equal(host.isBlocked(), false)
})
