import assert from 'node:assert/strict'
import test from 'node:test'

import {
  SessionMutationLoss,
  sessionMatchesExpectedWorkspace,
  type ExpectedWorkspaceTarget,
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

const targetedPayload = (
  token: string,
  target: ExpectedWorkspaceTarget,
): SessionPayload => ({
  me: {
    uoaWorkspaces: [
      { active: true, organizationId: target.organizationId, teamId: target.teamId },
    ],
  } as unknown as SessionPayload['me'],
  token,
})

const TARGET: ExpectedWorkspaceTarget = {
  organizationId: 'external-org',
  teamId: 'external-team',
}

const exactTargetGuard = (
  payload: SessionPayload,
): SessionMutationOutcome =>
  sessionMatchesExpectedWorkspace(payload, TARGET)
    ? { kind: 'target' }
    : { kind: 'foreign', message: 'The renewed session missed the requested workspace.' }

test('termination fences a late apply and logout deletes the winning session', async () => {
  let resolveSwitch: ((payload: SessionPayload) => void) | undefined
  const switchResult = new Promise<SessionPayload>((resolve) => {
    resolveSwitch = resolve
  })
  const events: string[] = []
  const coordinator = createSessionMutationCoordinator({
    applySession: (payload) => events.push(`apply:${payload.token}`),
    clearSession: () => events.push('clear'),
    refresh: async () => assert.fail('refresh is not part of logout'),
  })

  const switching = coordinator.run(() => switchResult)
  const logout = coordinator.terminate(async (latestPayload) => {
    events.push(`delete:${latestPayload?.token ?? 'none'}`)
  })
  const blockedMutation = coordinator.run(async () => {
    events.push('unexpected-mutation')
    return sessionPayload('unexpected-token')
  })

  await assert.rejects(blockedMutation, /session is being terminated/)
  assert.deepEqual(events, [])
  resolveSwitch?.(sessionPayload('switched-token'))

  await assert.rejects(switching, /session is being terminated/)
  await logout
  assert.deepEqual(events, ['delete:switched-token', 'clear'])
})

test('logout still deletes and clears after an in-flight mutation rejects', async () => {
  let rejectSwitch: ((error: Error) => void) | undefined
  const switchResult = new Promise<SessionPayload>((_resolve, reject) => {
    rejectSwitch = reject
  })
  const events: string[] = []
  const coordinator = createSessionMutationCoordinator({
    applySession: (payload) => events.push(`apply:${payload.token}`),
    clearSession: () => events.push('clear'),
    refresh: async () => assert.fail('refresh is not part of logout'),
  })

  const switching = coordinator.run(() => switchResult)
  const logout = coordinator.terminate(async (latestPayload) => {
    events.push(`delete:${latestPayload?.token ?? 'none'}`)
  })
  rejectSwitch?.(new Error('switch failed'))

  await assert.rejects(switching, /switch failed/)
  await logout
  assert.deepEqual(events, ['delete:none', 'clear'])
})

test('logout suppresses a session waiting at its cache-reset boundary', async () => {
  let enterBoundary: (() => void) | undefined
  let releaseBoundary: (() => void) | undefined
  const boundaryEntered = new Promise<void>((resolve) => {
    enterBoundary = resolve
  })
  const boundaryRelease = new Promise<void>((resolve) => {
    releaseBoundary = resolve
  })
  const events: string[] = []
  const coordinator = createSessionMutationCoordinator({
    beforeApply: async () => {
      events.push('before-apply')
      enterBoundary?.()
      await boundaryRelease
    },
    applySession: (payload) => events.push(`apply:${payload.token}`),
    clearSession: () => events.push('clear'),
    refresh: async () => assert.fail('refresh is not part of logout'),
  })

  const switching = coordinator.run(async () => sessionPayload('switched-token'))
  await boundaryEntered
  const logout = coordinator.terminate(async (latestPayload) => {
    events.push(`delete:${latestPayload?.token ?? 'none'}`)
  })
  releaseBoundary?.()

  await assert.rejects(switching, /session is being terminated/)
  await logout
  assert.deepEqual(events, ['before-apply', 'delete:switched-token', 'clear'])
})

test('terminate is idempotent and permanently terminal', async () => {
  let finalizeCalls = 0
  const events: string[] = []
  const coordinator = createSessionMutationCoordinator({
    applySession: (payload) => events.push(`apply:${payload.token}`),
    clearSession: () => events.push('clear'),
    refresh: async () => assert.fail('refresh is not part of logout'),
  })

  const first = coordinator.terminate(async () => {
    finalizeCalls += 1
  })
  const second = coordinator.terminate(async () => {
    assert.fail('a repeated terminate never re-runs its finalize')
  })
  assert.strictEqual(first, second)

  await first
  assert.equal(finalizeCalls, 1)
  assert.deepEqual(events, ['clear'])

  // No later mutation may apply a session, ever.
  await assert.rejects(
    coordinator.run(async () => {
      events.push('unexpected-mutation')
      return sessionPayload('late-token')
    }),
    /session is being terminated/,
  )
  await assert.rejects(coordinator.refresh(), /session is being terminated/)
  await assert.rejects(coordinator.reconcile(), /session is being terminated/)
  assert.deepEqual(events, ['clear'])
})

test('a late apply during the terminate drain is fenced and handed to logout', async () => {
  let resolveSwitch: ((payload: SessionPayload) => void) | undefined
  const switchResult = new Promise<SessionPayload>((resolve) => {
    resolveSwitch = resolve
  })
  const events: string[] = []
  const coordinator = createSessionMutationCoordinator({
    applySession: (payload) => events.push(`apply:${payload.token}`),
    clearSession: () => events.push('clear'),
    refresh: async () => assert.fail('refresh is not part of logout'),
  })

  const switching = coordinator.run(() => switchResult)
  const logout = coordinator.terminate(async (latestPayload) => {
    events.push(`delete:${latestPayload?.token ?? 'none'}`)
    // A mutation queued while logout drains is refused, not run.
    await assert.rejects(
      coordinator.run(async () => sessionPayload('late-token')),
      /session is being terminated/,
    )
  })

  resolveSwitch?.(sessionPayload('switched-token'))
  await assert.rejects(switching, /session is being terminated/)
  await logout
  assert.deepEqual(events, ['delete:switched-token', 'clear'])
})

test('an in-flight guarded loss plus terminate clears exactly once', async () => {
  let resolveRefresh: ((payload: SessionPayload | null) => void) | undefined
  const refreshResult = new Promise<SessionPayload | null>((resolve) => {
    resolveRefresh = resolve
  })
  const events: string[] = []
  const coordinator = createSessionMutationCoordinator({
    applySession: (payload) => events.push(`apply:${payload.token}`),
    clearSession: () => events.push('clear'),
    onForeignSession: (payload) => events.push(`revoke:${payload.token}`),
    refresh: () => refreshResult,
  })

  const exchanging = coordinator.runGuarded(
    async () => {
      throw new SessionMutationLoss('The session response was lost in transit.')
    },
    exactTargetGuard,
  )
  // The guarded mutation is parked awaiting its one raw refresh; logout
  // begins in the meantime.
  const logout = coordinator.terminate(async (latestPayload) => {
    events.push(`delete:${latestPayload?.token ?? 'none'}`)
  })

  // The winner arrives while logout is in flight: it is never classified or
  // adopted — termination wins over the guard, so the winner is handed to
  // the logout finalizer (never foreign-revoked) and the recovery rejects
  // as terminated, not as a foreign mismatch.
  resolveRefresh?.(targetedPayload('foreign-token', {
    organizationId: 'other-org',
    teamId: 'other-team',
  }))
  await assert.rejects(exchanging, /session is being terminated/)
  await logout
  // Exactly one clear: the guarded path does not clear on a terminated
  // winner, so terminate's own clear is the only one. The finalizer deletes
  // the winning session's family, and no foreign revocation ever ran.
  assert.deepEqual(events, ['delete:foreign-token', 'clear'])
  // Termination is permanent: no later mutation, refresh, or reconcile.
  await assert.rejects(coordinator.reconcile(), /session is being terminated/)
  await assert.rejects(coordinator.refresh(), /session is being terminated/)
  assert.deepEqual(events, ['delete:foreign-token', 'clear'])
})

test('an opaque loss permits exactly one raw refresh and applies its exact-target winner', async () => {
  const events: string[] = []
  let refreshCalls = 0
  const coordinator = createSessionMutationCoordinator({
    applySession: (payload) => events.push(`apply:${payload.token}`),
    clearSession: () => events.push('clear'),
    refresh: async () => {
      refreshCalls += 1
      return targetedPayload('targeted-token', TARGET)
    },
  })

  const recovered = await coordinator.runGuarded(
    async () => {
      throw new SessionMutationLoss('The session response body could not be read.')
    },
    exactTargetGuard,
  )

  assert.equal(recovered.token, 'targeted-token')
  assert.equal(refreshCalls, 1)
  assert.deepEqual(events, ['apply:targeted-token'])
})

test('a mismatched direct payload is terminally fenced without a refresh; typed errors preserve the old session', async () => {
  const events: string[] = []
  let refreshCalls = 0
  const coordinator = createSessionMutationCoordinator({
    applySession: (payload) => events.push(`apply:${payload.token}`),
    clearSession: () => events.push('clear'),
    onForeignSession: (payload) => events.push(`revoke:${payload.token}`),
    refresh: async () => {
      refreshCalls += 1
      return targetedPayload('foreign-refresh', {
        organizationId: 'other-org',
        teamId: 'other-team',
      })
    },
  })

  // A decoded direct mismatch is not opaque: the foreign session is fenced
  // out of apply and out of every later reconcile/refresh, its family is
  // revoked, the session clears exactly once — and no raw refresh runs.
  await assert.rejects(
    coordinator.runGuarded(
      async () => targetedPayload('foreign-token', {
        organizationId: 'other-org',
        teamId: 'other-team',
      }),
      exactTargetGuard,
    ),
    /missed the requested workspace/,
  )
  assert.equal(refreshCalls, 0)
  assert.deepEqual(events, ['revoke:foreign-token', 'clear'])

  // The fence is permanent: later reconcile/refresh can never adopt it.
  await assert.rejects(coordinator.reconcile(), /fenced over a foreign session/)
  await assert.rejects(coordinator.refresh(), /fenced over a foreign session/)
  assert.equal(refreshCalls, 0)
  assert.deepEqual(events, ['revoke:foreign-token', 'clear'])
})

test('a typed server refusal (HTTP status) never refreshes, clears, or fences', async () => {
  const events: string[] = []
  let refreshCalls = 0
  const coordinator = createSessionMutationCoordinator({
    applySession: (payload) => events.push(`apply:${payload.token}`),
    clearSession: () => events.push('clear'),
    onForeignSession: (payload) => events.push(`revoke:${payload.token}`),
    refresh: async () => {
      refreshCalls += 1
      return targetedPayload('foreign-refresh', {
        organizationId: 'other-org',
        teamId: 'other-team',
      })
    },
  })

  await assert.rejects(
    coordinator.runGuarded(
      async () => {
        const refusal = new Error('The server refused the exchange.')
        refusal.name = 'AuthSessionApiError'
        throw refusal
      },
      exactTargetGuard,
    ),
    /server refused the exchange/,
  )
  assert.equal(refreshCalls, 0)
  assert.deepEqual(events, [])

  // The old session is fully preserved: a later exact-target mutation runs.
  const accepted = await coordinator.runGuarded(
    async () => targetedPayload('targeted-token', TARGET),
    exactTargetGuard,
  )
  assert.equal(accepted.token, 'targeted-token')
  assert.deepEqual(events, ['apply:targeted-token'])
})

test('an exact-target direct payload applies without any refresh', async () => {
  const events: string[] = []
  const coordinator = createSessionMutationCoordinator({
    applySession: (payload) => events.push(`apply:${payload.token}`),
    clearSession: () => events.push('clear'),
    refresh: async () => assert.fail('no refresh after an accepted payload'),
  })

  const accepted = await coordinator.runGuarded(
    async () => targetedPayload('targeted-token', TARGET),
    exactTargetGuard,
  )
  assert.equal(accepted.token, 'targeted-token')
  assert.deepEqual(events, ['apply:targeted-token'])
})
test('a foreign refresh winner after an opaque loss terminally fences without adopting it', async () => {
  const events: string[] = []
  let refreshCalls = 0
  const coordinator = createSessionMutationCoordinator({
    applySession: (payload) => {
      events.push(`apply:${payload.token}`)
    },
    clearSession: () => events.push('clear'),
    onForeignSession: (payload) => {
      events.push(`revoke:${payload.token}`)
    },
    refresh: async () => {
      refreshCalls += 1
      return targetedPayload('foreign-token', { organizationId: 'other-org', teamId: 'other-team' })
    },
  })

  await assert.rejects(
    coordinator.runGuarded(
      async () => {
        throw new SessionMutationLoss('The session response body could not be read.')
      },
      exactTargetGuard,
    ),
    /missed the requested workspace/,
  )
  assert.equal(refreshCalls, 1)
  // Never clear-then-adopt the unvalidated winner: the foreign session is
  // fenced out of apply, its cookie family revoked, and the stale local
  // session cleared exactly once — permanently.
  assert.deepEqual(events, ['revoke:foreign-token', 'clear'])
  await assert.rejects(coordinator.refresh(), /fenced over a foreign session/)
  await assert.rejects(coordinator.reconcile(), /fenced over a foreign session/)
  assert.equal(refreshCalls, 1)
  assert.deepEqual(events, ['revoke:foreign-token', 'clear'])
})

test('a normal Error named SessionMutationLoss is not an opaque loss', async () => {
  const events: string[] = []
  let refreshCalls = 0
  const coordinator = createSessionMutationCoordinator({
    applySession: (payload) => {
      events.push(`apply:${payload.token}`)
    },
    clearSession: () => events.push('clear'),
    onForeignSession: (payload) => {
      events.push(`revoke:${payload.token}`)
    },
    refresh: async () => {
      refreshCalls += 1
      return targetedPayload('unexpected-refresh', { organizationId: 'other-org', teamId: 'other-team' })
    },
  })

  await assert.rejects(
    coordinator.runGuarded(
      async () => {
        const forged = new Error('forged opaque loss')
        forged.name = 'SessionMutationLoss'
        throw forged
      },
      exactTargetGuard,
    ),
    (error: unknown) => {
      assert.ok(error instanceof Error)
      assert.ok(!(error instanceof SessionMutationLoss))
      assert.equal(error.message, 'forged opaque loss')
      return true
    },
  )
  // Detection is real instanceof, never error.name: a forged name triggers
  // neither a raw refresh nor a fence.
  assert.equal(refreshCalls, 0)
  assert.deepEqual(events, [])
})
