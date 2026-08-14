import assert from 'node:assert/strict'
import test from 'node:test'

import {
  SessionMutationLoss,
  SessionSourcePreserved,
  type SessionPayload,
} from '../src/auth-session.js'
import {
  createSessionMutationCoordinator,
  type SessionMutationOutcome,
} from '../src/session-mutation-coordinator.js'

const sessionPayload = (token: string): SessionPayload => ({
  me: {} as SessionPayload['me'],
  token,
})

const exactTokenGuard = (
  payload: SessionPayload,
): SessionMutationOutcome =>
  payload.token === 'targeted-token'
    ? { kind: 'target' }
    : { kind: 'foreign', message: 'The renewed session missed the requested workspace.' }

test('runGuarded applies a direct success the exact-target guard accepts', async () => {
  const events: string[] = []
  const coordinator = createSessionMutationCoordinator({
    beforeApply: (payload) => {
      events.push(`before:${payload.token}`)
    },
    applySession: (payload) => {
      events.push(`apply:${payload.token}`)
    },
    clearSession: () => assert.fail('session must remain authenticated'),
    refresh: async () => assert.fail('no refresh after an accepted payload'),
  })

  const accepted = await coordinator.runGuarded(
    async () => sessionPayload('targeted-token'),
    exactTokenGuard,
  )
  assert.equal(accepted.token, 'targeted-token')
  assert.deepEqual(events, ['before:targeted-token', 'apply:targeted-token'])
})

test('a decoded direct mismatch terminally fences the coordinator without any refresh', async () => {
  const events: string[] = []
  let refreshCalls = 0
  let foreignRevocations = 0
  const coordinator = createSessionMutationCoordinator({
    beforeApply: (payload) => {
      events.push(`before:${payload.token}`)
    },
    applySession: (payload) => {
      events.push(`apply:${payload.token}`)
    },
    clearSession: () => {
      events.push('clear')
    },
    onForeignSession: (payload) => {
      foreignRevocations += 1
      events.push(`revoke:${payload.token}`)
    },
    onTerminal: () => {
      events.push('terminal')
    },
    refresh: async () => {
      refreshCalls += 1
      return sessionPayload('unexpected-refresh')
    },
  })

  await assert.rejects(
    coordinator.runGuarded(
      async () => sessionPayload('foreign-token'),
      exactTokenGuard,
    ),
    /missed the requested workspace/,
  )
  // A decoded direct mismatch is not opaque: the foreign session is handed to
  // the caller-owned revocation callback exactly once, the local session is
  // cleared exactly once, and no blind refresh ran.
  assert.equal(refreshCalls, 0)
  assert.equal(foreignRevocations, 1)
  assert.deepEqual(events, ['revoke:foreign-token', 'clear', 'terminal'])

  // The fence is permanent: no later reconcile or refresh can ever apply the
  // foreign session.
  await assert.rejects(coordinator.reconcile(), /fenced over a foreign session/)
  await assert.rejects(coordinator.refresh(), /fenced over a foreign session/)
  await assert.rejects(
    coordinator.runGuarded(async () => sessionPayload('foreign-token'), exactTokenGuard),
    /fenced over a foreign session/,
  )
  assert.equal(refreshCalls, 0)
  assert.equal(foreignRevocations, 1)
  // Exactly one terminal notification even across the repeated fence probes.
  assert.deepEqual(events, ['revoke:foreign-token', 'clear', 'terminal'])
})

test('runGuarded accepts the exact-target refresh winner after an opaque loss', async () => {
  const events: string[] = []
  let refreshCalls = 0
  const coordinator = createSessionMutationCoordinator({
    beforeApply: (payload) => {
      events.push(`before:${payload.token}`)
    },
    applySession: (payload) => {
      events.push(`apply:${payload.token}`)
    },
    clearSession: () => events.push('clear'),
    refresh: async () => {
      refreshCalls += 1
      return sessionPayload('targeted-token')
    },
  })

  const recovered = await coordinator.runGuarded(
    async () => {
      throw new SessionMutationLoss('The session response was lost in transit.')
    },
    exactTokenGuard,
  )
  assert.equal(recovered.token, 'targeted-token')
  assert.equal(refreshCalls, 1)
  // The winner was checked BEFORE the apply hooks and nothing was cleared.
  assert.deepEqual(events, ['before:targeted-token', 'apply:targeted-token'])
})

test('an opaque source capture survives the refresh and still rejects as preserved', async () => {
  // Regression: the source must be a lexical binding captured inside the
  // queued thunk, never a property attached to the direct payload — the one
  // refresh winner after an opaque loss is a raw payload with nothing
  // attached, and must STILL classify as the preserved source.
  const events: string[] = []
  let refreshCalls = 0
  const coordinator = createSessionMutationCoordinator({
    beforeApply: (payload) => {
      events.push(`before:${payload.token}`)
    },
    applySession: (payload) => {
      events.push(`apply:${payload.token}`)
    },
    clearSession: () => events.push('clear'),
    onForeignSession: (payload) => events.push(`revoke:${payload.token}`),
    refresh: async () => {
      refreshCalls += 1
      // A raw refresh payload — provably no property the thunk could have
      // attached to its own direct response.
      return sessionPayload('rotated-source-token')
    },
  })

  let source = ''
  await assert.rejects(
    coordinator.runGuarded(
      async () => {
        // The source is captured inside the queued thunk, where the session
        // is current when the request is actually sent.
        source = 'rotated-source-token'
        throw new SessionMutationLoss('The session response was lost in transit.')
      },
      (payload) =>
        payload.token === source
          ? { kind: 'source', message: 'The preserved source session was renewed.' }
          : { kind: 'foreign', message: 'The renewed session is foreign.' },
    ),
    (error: unknown) => {
      assert.ok(error instanceof SessionSourcePreserved)
      assert.equal(error.message, 'The preserved source session was renewed.')
      return true
    },
  )
  assert.equal(refreshCalls, 1)
  // The fresh source token IS applied (the rotated access token survives),
  // but nothing is revoked or cleared and the coordinator is NOT fenced.
  assert.deepEqual(events, ['before:rotated-source-token', 'apply:rotated-source-token'])
  const next = await coordinator.run(async () => sessionPayload('next-token'))
  assert.equal(next.token, 'next-token')
  assert.deepEqual(events, [
    'before:rotated-source-token',
    'apply:rotated-source-token',
    'before:next-token',
    'apply:next-token',
  ])
})

test('a typed refusal surfaces without any refresh', async () => {
  const events: string[] = []
  let refreshCalls = 0
  const coordinator = createSessionMutationCoordinator({
    applySession: (payload) => {
      events.push(`apply:${payload.token}`)
    },
    clearSession: () => events.push('clear'),
    refresh: async () => {
      refreshCalls += 1
      return sessionPayload('unexpected-refresh')
    },
  })

  await assert.rejects(
    coordinator.runGuarded(
      async () => {
        const refusal = new Error('The renewed session is not on the requested workspace.')
        refusal.name = 'AuthSessionApiError'
        throw refusal
      },
      () => ({ kind: 'target' }),
    ),
    /not on the requested workspace/,
  )
  assert.equal(refreshCalls, 0)
  assert.deepEqual(events, [])
})

test('runGuarded serializes behind an in-flight session mutation', async () => {
  let resolveRefresh: ((payload: SessionPayload) => void) | undefined
  const refreshResult = new Promise<SessionPayload>((resolve) => {
    resolveRefresh = resolve
  })
  const applied: string[] = []
  const coordinator = createSessionMutationCoordinator({
    applySession: (payload) => applied.push(payload.token),
    clearSession: () => assert.fail('session must remain authenticated'),
    refresh: () => refreshResult,
  })

  const renewing = coordinator.refresh()
  const exchanging = coordinator.runGuarded(
    async () => sessionPayload('exchanged-token'),
    () => ({ kind: 'target' }),
  )

  resolveRefresh?.(sessionPayload('renewed-token'))
  assert.equal(await renewing, 'renewed-token')
  assert.equal((await exchanging).token, 'exchanged-token')
  assert.deepEqual(applied, ['renewed-token', 'exchanged-token'])
})

test('an overlapping foreign fence and terminate notify terminal exactly once', async () => {
  let releaseForeign: (() => void) | undefined
  const foreignReleased = new Promise<void>((resolve) => {
    releaseForeign = resolve
  })
  const events: string[] = []
  const coordinator = createSessionMutationCoordinator({
    applySession: (payload) => events.push(`apply:${payload.token}`),
    clearSession: () => events.push('clear'),
    onForeignSession: async (payload) => {
      events.push(`revoke:${payload.token}`)
      // Hold the fence open so terminate() begins mid-fence: the two
      // terminal paths overlap, and still only one notification may fire.
      await foreignReleased
    },
    onTerminal: () => events.push('terminal'),
    refresh: async () => assert.fail('no refresh in this scenario'),
  })

  const fenced = coordinator.runGuarded(
    async () => sessionPayload('foreign-token'),
    (payload) =>
      payload.token === 'targeted-token'
        ? { kind: 'target' }
        : { kind: 'foreign', message: 'The renewed session is foreign.' },
  )
  const logout = coordinator.terminate(async () => {
    events.push('logout-finalize')
  })

  releaseForeign?.()
  await assert.rejects(fenced, /The renewed session is foreign/)
  await logout
  assert.deepEqual(events, ['revoke:foreign-token', 'clear', 'terminal', 'logout-finalize'])
})
