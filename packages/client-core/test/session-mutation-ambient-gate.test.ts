import assert from 'node:assert/strict'
import test from 'node:test'

import {
  ForeignSessionDetected,
  SessionMutationLoss,
  type SessionPayload,
} from '../src/auth-session.js'
import { createSessionMutationCoordinator } from '../src/session-mutation-coordinator.js'

const sessionPayload = (token: string): SessionPayload => ({
  me: {} as SessionPayload['me'],
  token,
})

// Mirrors the provider wiring: the host sets the synchronous gate from
// onTerminalStart (the moment terminate or a foreign fence begins), hands
// the reader to every coordinator generation, and clears it only after a
// successfully applied explicit login.
const createGatedHost = (input: {
  onClear?: () => void
  onForeignSession?: () => Promise<void>
  onRefresh?: () => Promise<SessionPayload | null>
}) => {
  let blocked = false
  let refreshCalls = 0
  const events: string[] = []
  const build = () => createSessionMutationCoordinator({
    applySession: (payload) => events.push(`apply:${payload.token}`),
    clearSession: () => {
      events.push('clear')
      input.onClear?.()
    },
    isAmbientRefreshBlocked: () => blocked,
    onForeignSession: async () => {
      events.push('revoke')
      await input.onForeignSession?.()
    },
    onTerminal: () => {
      events.push('terminal')
    },
    onTerminalStart: () => {
      blocked = true
      events.push('terminal-start')
    },
    refresh: () => {
      refreshCalls += 1
      return input.onRefresh?.() ?? Promise.resolve(sessionPayload('renewed-token'))
    },
  })
  return {
    build,
    get blocked() { return blocked },
    set blocked(value: boolean) { blocked = value },
    events,
    get refreshCalls() { return refreshCalls },
  }
}

test('a terminal logout blocks ambient refresh on the SAME coordinator and every recreation', async () => {
  const host = createGatedHost({})
  const first = host.build()

  await first.terminate(async () => undefined)
  assert.equal(host.blocked, true)
  assert.deepEqual(host.events, ['terminal-start', 'clear', 'terminal'])

  // A stale caller holding the retired coordinator's facade is refused
  // before any refresh request — even though terminate alone would only
  // reject as terminated, the gate rejects as ambient-blocked and reads at
  // call time.
  await assert.rejects(first.refresh(), /ambient refresh is blocked/)
  await assert.rejects(first.reconcile(), /ambient refresh is blocked/)
  assert.equal(host.refreshCalls, 0)

  // The recreated coordinator (post-terminal generation) is gated too: no
  // automatic startup restoration may consume a still-live refresh cookie.
  const recreated = host.build()
  await assert.rejects(recreated.refresh(), /ambient refresh is blocked/)
  await assert.rejects(recreated.reconcile(), /ambient refresh is blocked/)
  assert.equal(host.refreshCalls, 0)
})

test('a foreign-session fence blocks ambient refresh on the recreated coordinator', async () => {
  const host = createGatedHost({})
  const first = host.build()

  await assert.rejects(
    first.runGuarded(
      async () => sessionPayload('foreign-token'),
      () => ({ kind: 'foreign', message: 'The renewed session is foreign.' }),
    ),
    ForeignSessionDetected,
  )
  assert.equal(host.blocked, true)

  const recreated = host.build()
  await assert.rejects(recreated.refresh(), /ambient refresh is blocked/)
  assert.equal(host.refreshCalls, 0)
})

test('an applied explicit login reopens ambient refresh on the recreated coordinator', async () => {
  const host = createGatedHost({})
  const first = host.build()
  await first.terminate(async () => undefined)

  const recreated = host.build()
  // Explicit run is never gated: the login applies even while blocked...
  const loggedIn = await recreated.run(async () => sessionPayload('login-token'))
  assert.equal(loggedIn.token, 'login-token')
  // ...and its successful apply is what clears the gate, so ambient refresh
  // works again afterwards.
  host.blocked = false
  assert.equal(await recreated.refresh(), 'renewed-token')
  assert.equal(host.refreshCalls, 1)
  assert.deepEqual(host.events, [
    'terminal-start',
    'clear',
    'terminal',
    'apply:login-token',
    'apply:renewed-token',
  ])
})

test('the gate reads at call time: a caller holding the facade from before the fence is refused', async () => {
  const host = createGatedHost({})
  const coordinator = host.build()
  // Capture the facade before any terminal event — the shape of a startup
  // restore scheduled in a previous render.
  const capturedRefresh = coordinator.refresh

  await coordinator.terminate(async () => undefined)
  await assert.rejects(capturedRefresh(), /ambient refresh is blocked/)
  assert.equal(host.refreshCalls, 0)
})

test('the ambient gate never blocks explicit run/runGuarded mutations', async () => {
  const host = createGatedHost({})
  const coordinator = host.build()
  await coordinator.terminate(async () => undefined)
  assert.equal(host.blocked, true)

  const recreated = host.build()
  const guarded = await recreated.runGuarded(
    async () => sessionPayload('recovered-token'),
    () => ({ kind: 'target' }),
  )
  assert.equal(guarded.token, 'recovered-token')
  assert.deepEqual(host.events, ['terminal-start', 'clear', 'terminal', 'apply:recovered-token'])
})

test('a refresh winner after an opaque loss is internal and never gated', async () => {
  const host = createGatedHost({
    onRefresh: async () => sessionPayload('winner-token'),
  })
  // Pre-block the gate: only ambient facade calls are refused; the guarded
  // mutation's one internal refresh must still run.
  host.blocked = true
  const coordinator = host.build()

  const recovered = await coordinator.runGuarded(
    async () => {
      throw new SessionMutationLoss('The session response was lost in transit.')
    },
    () => ({ kind: 'target' }),
  )
  assert.equal(recovered.token, 'winner-token')
  assert.equal(host.refreshCalls, 1)
  assert.deepEqual(host.events, ['apply:winner-token'])
})

test('a run joined before the gate is set is never blocked mid-flight', async () => {
  let resolveRefresh: ((payload: SessionPayload) => void) | undefined
  const refreshResult = new Promise<SessionPayload>((resolve) => {
    resolveRefresh = resolve
  })
  const host = createGatedHost({ onRefresh: () => refreshResult })
  const coordinator = host.build()

  // The refresh joins while the gate is open; the gate closes mid-flight.
  const refreshing = coordinator.refresh()
  host.blocked = true
  resolveRefresh?.(sessionPayload('joined-token'))
  assert.equal(await refreshing, 'joined-token')
  assert.equal(host.refreshCalls, 1)
})

test('the terminal-start hook fires synchronously at terminate begin, before a stalled finalizer settles', async () => {
  let finalizerBegan!: () => void
  let settleFinalizer!: () => void
  const began = new Promise<void>((resolve) => {
    finalizerBegan = resolve
  })
  const host = createGatedHost({})
  const coordinator = host.build()

  // Begin terminate with a finalizer that stays unresolved — the shape of a
  // stalled or slowly-failing logout DELETE.
  const termination = coordinator.terminate(
    () => {
      finalizerBegan()
      return new Promise<void>((resolve) => {
        settleFinalizer = resolve
      })
    },
  )
  // The start hook already fired, synchronously, before ANY awaited work:
  // the gate is set before the finalizer even runs.
  assert.equal(host.blocked, true)
  assert.deepEqual(host.events, ['terminal-start', 'clear'])

  // Deterministic: hold until the finalizer is actually in flight — the gate
  // was still set first.
  await began
  assert.deepEqual(host.events, ['terminal-start', 'clear'])

  settleFinalizer()
  await termination
  assert.deepEqual(host.events, ['terminal-start', 'clear', 'terminal'])
})

test('the terminal-start hook fires before a stalled foreign revocation settles', async () => {
  let revocationBegan!: () => void
  let settleRevocation!: () => void
  const began = new Promise<void>((resolve) => {
    revocationBegan = resolve
  })
  const pending = new Promise<void>((resolve) => {
    settleRevocation = resolve
  })
  const host = createGatedHost({
    onForeignSession: () => {
      revocationBegan()
      return pending
    },
  })
  const coordinator = host.build()

  const fenced = coordinator.runGuarded(
    async () => sessionPayload('foreign-token'),
    () => ({ kind: 'foreign', message: 'The renewed session is foreign.' }),
  )
  // Deterministic: wait until the fence's revocation is actually in flight,
  // then prove the gate was already set before that awaited work began.
  await began
  assert.equal(host.blocked, true)
  assert.deepEqual(host.events, ['terminal-start', 'clear', 'revoke'])

  settleRevocation()
  await assert.rejects(fenced, ForeignSessionDetected)
})

test('throwing terminal hooks and local clear cannot abort finalization', async () => {
  const events: string[] = []
  const coordinator = createSessionMutationCoordinator({
    applySession: () => assert.fail('a terminal coordinator never applies'),
    clearLocal: () => {
      events.push('clear')
      throw new Error('local storage denied')
    },
    clearSession: () => assert.fail('clearLocal supersedes the fallback clear'),
    onTerminalStart: () => {
      events.push('terminal-start')
      throw new Error('marker write denied')
    },
    onTerminal: () => {
      events.push('terminal')
      throw new Error('host already unmounted')
    },
    refresh: async () => assert.fail('refresh is not part of logout'),
  })

  await coordinator.terminate(async () => {
    events.push('finalize')
  })
  assert.deepEqual(events, ['terminal-start', 'clear', 'finalize', 'terminal'])
  await assert.rejects(coordinator.refresh(), /session is being terminated/)
})

test('logout captures the old bearer before its held finalizer clears local auth', async () => {
  let localBearer: string | null = 'old-bearer'
  let releaseFinalizer!: () => void
  let finalizerBegan!: () => void
  const began = new Promise<void>((resolve) => {
    finalizerBegan = resolve
  })
  const coordinator = createSessionMutationCoordinator({
    applySession: () => assert.fail('a terminal coordinator never applies'),
    clearLocal: () => {
      localBearer = null
    },
    clearSession: () => assert.fail('clearLocal supersedes the fallback clear'),
    refresh: async () => assert.fail('refresh is not part of logout'),
  })

  const capturedBearer = localBearer
  const termination = coordinator.terminate(async (latestPayload) => {
    assert.equal(localBearer, null)
    assert.equal(latestPayload?.token ?? capturedBearer, 'old-bearer')
    finalizerBegan()
    await new Promise<void>((resolve) => {
      releaseFinalizer = resolve
    })
  })

  assert.equal(localBearer, null)
  await began
  releaseFinalizer()
  await termination
})
