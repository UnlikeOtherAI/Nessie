import assert from 'node:assert/strict'
import test from 'node:test'

import type { SessionPayload } from '../src/auth-session.js'
import {
  createAccessTokenRefreshCoordinator,
  createSessionMutationCoordinator,
} from '../src/session-mutation-coordinator.js'

const sessionPayload = (token: string): SessionPayload => ({
  me: {} as SessionPayload['me'],
  token,
})

test('access-token refresh coordinator is single-flight', async () => {
  let resolveRefresh: ((payload: SessionPayload) => void) | undefined
  let refreshCalls = 0
  let applyCalls = 0
  let clearCalls = 0
  const refreshResult = new Promise<SessionPayload>((resolve) => {
    resolveRefresh = resolve
  })
  const refresh = createAccessTokenRefreshCoordinator({
    applySession: () => {
      applyCalls += 1
    },
    clearSession: () => {
      clearCalls += 1
    },
    refresh: () => {
      refreshCalls += 1
      return refreshResult
    },
  })

  const startupRenewal = refresh()
  const api401Renewal = refresh()
  assert.strictEqual(startupRenewal, api401Renewal)
  assert.equal(refreshCalls, 1)

  resolveRefresh?.(sessionPayload('renewed-token'))
  assert.deepEqual(
    await Promise.all([startupRenewal, api401Renewal]),
    ['renewed-token', 'renewed-token'],
  )
  assert.equal(applyCalls, 1)
  assert.equal(clearCalls, 0)
})

test('coordinator clears only on explicit rejection and retries transient failures', async () => {
  let refreshCalls = 0
  let applyCalls = 0
  let clearCalls = 0
  const refresh = createAccessTokenRefreshCoordinator({
    applySession: () => {
      applyCalls += 1
    },
    clearSession: () => {
      clearCalls += 1
    },
    refresh: async () => {
      refreshCalls += 1
      if (refreshCalls === 1) {
        throw new Error('Temporary outage')
      }
      return sessionPayload('recovered-token')
    },
  })

  await assert.rejects(refresh(), /Temporary outage/)
  assert.equal(clearCalls, 0)
  assert.equal(await refresh(), 'recovered-token')
  assert.equal(refreshCalls, 2)
  assert.equal(applyCalls, 1)
  assert.equal(clearCalls, 0)

  const rejectRefresh = createAccessTokenRefreshCoordinator({
    applySession: () => {
      applyCalls += 1
    },
    clearSession: () => {
      clearCalls += 1
    },
    refresh: async () => null,
  })
  assert.equal(await rejectRefresh(), null)
  assert.equal(clearCalls, 1)
})

test('session mutation coordinator makes refresh join an in-flight workspace switch', async () => {
  let resolveSwitch: ((payload: SessionPayload) => void) | undefined
  let refreshCalls = 0
  const applied: string[] = []
  const switchResult = new Promise<SessionPayload>((resolve) => {
    resolveSwitch = resolve
  })
  const coordinator = createSessionMutationCoordinator({
    applySession: (payload) => applied.push(payload.token),
    clearSession: () => assert.fail('session must remain authenticated'),
    refresh: async () => {
      refreshCalls += 1
      return sessionPayload('unexpected-refresh')
    },
  })

  const switching = coordinator.run(() => switchResult)
  const renewing = coordinator.refresh()
  assert.equal(refreshCalls, 0)

  resolveSwitch?.(sessionPayload('switched-token'))
  assert.equal((await switching).token, 'switched-token')
  assert.equal(await renewing, 'switched-token')
  assert.deepEqual(applied, ['switched-token'])
})

test('explicit mutations queue FIFO behind in-flight work and every queued mutation runs', async () => {
  let resolveRefresh: ((payload: SessionPayload) => void) | undefined
  const refreshResult = new Promise<SessionPayload>((resolve) => {
    resolveRefresh = resolve
  })
  const events: string[] = []
  const coordinator = createSessionMutationCoordinator({
    applySession: (payload) => events.push(`apply:${payload.token}`),
    clearSession: () => assert.fail('session must remain authenticated'),
    refresh: () => refreshResult,
  })

  const renewing = coordinator.refresh()
  const mutationA = coordinator.run(async () => {
    events.push('mutate:A')
    return sessionPayload('token-A')
  })
  const mutationB = coordinator.run(async () => {
    events.push('mutate:B')
    return sessionPayload('token-B')
  })

  // Nothing runs until the in-flight refresh settles; A then B in FIFO order.
  assert.deepEqual(events, [])
  resolveRefresh?.(sessionPayload('renewed-token'))
  assert.equal(await renewing, 'renewed-token')
  assert.equal((await mutationA).token, 'token-A')
  assert.equal((await mutationB).token, 'token-B')
  assert.deepEqual(events, [
    'apply:renewed-token',
    'mutate:A',
    'apply:token-A',
    'mutate:B',
    'apply:token-B',
  ])
})

test('session mutation coordinator runs its global before-apply for every mutation', async () => {
  let resolveRefresh: ((payload: SessionPayload) => void) | undefined
  let currentToken = 'old-token'
  const events: string[] = []
  const refreshResult = new Promise<SessionPayload>((resolve) => {
    resolveRefresh = resolve
  })
  const coordinator = createSessionMutationCoordinator({
    beforeApply: (payload) => {
      events.push(`before:${payload.token}`)
    },
    applySession: (payload) => {
      currentToken = payload.token
      events.push(`apply:${payload.token}`)
    },
    clearSession: () => assert.fail('session must remain authenticated'),
    refresh: () => refreshResult,
  })

  const renewing = coordinator.refresh()
  const switching = coordinator.run(async () => {
    events.push(`switch:${currentToken}`)
    return sessionPayload('switched-token')
  })

  resolveRefresh?.(sessionPayload('renewed-token'))
  assert.equal(await renewing, 'renewed-token')
  assert.equal((await switching).token, 'switched-token')
  assert.deepEqual(events, [
    'before:renewed-token',
    'apply:renewed-token',
    'switch:renewed-token',
    'before:switched-token',
    'apply:switched-token',
  ])
})

test('session mutation coordinator exposes the refreshed payload and token-only API', async () => {
  let resolveRefresh: ((payload: SessionPayload) => void) | undefined
  let refreshCalls = 0
  const refreshResult = new Promise<SessionPayload>((resolve) => {
    resolveRefresh = resolve
  })
  const coordinator = createSessionMutationCoordinator({
    applySession: () => undefined,
    clearSession: () => assert.fail('session must remain authenticated'),
    refresh: () => {
      refreshCalls += 1
      return refreshResult
    },
  })

  const reconciling = coordinator.reconcile()
  const refreshing = coordinator.refresh()
  assert.equal(refreshCalls, 1)

  const payload = sessionPayload('renewed-token')
  resolveRefresh?.(payload)
  assert.equal(await reconciling, payload)
  assert.equal(await refreshing, 'renewed-token')
})

test('payload reconciliation refreshes after a failed explicit mutation', async () => {
  let refreshCalls = 0
  const coordinator = createSessionMutationCoordinator({
    applySession: () => undefined,
    clearSession: () => assert.fail('session must remain authenticated'),
    refresh: async () => {
      refreshCalls += 1
      return sessionPayload('reconciled-token')
    },
  })

  await assert.rejects(
    coordinator.run(async () => {
      throw new TypeError('response body was lost')
    }),
    /response body was lost/,
  )

  assert.equal((await coordinator.reconcile())?.token, 'reconciled-token')
  assert.equal(refreshCalls, 1)
})

test('a failed mutation never blocks its queued successor', async () => {
  const events: string[] = []
  const coordinator = createSessionMutationCoordinator({
    applySession: (payload) => events.push(`apply:${payload.token}`),
    clearSession: () => events.push('clear'),
    refresh: async () => assert.fail('no refresh in this scenario'),
  })

  await assert.rejects(
    coordinator.run(async () => {
      events.push('mutate:A')
      throw new Error('mutation A failed')
    }),
    /mutation A failed/,
  )
  const succeeded = await coordinator.run(async () => {
    events.push('mutate:B')
    return sessionPayload('token-B')
  })

  assert.equal(succeeded.token, 'token-B')
  assert.deepEqual(events, ['mutate:A', 'mutate:B', 'apply:token-B'])
})

test('a mutation enqueued behind a failed mutation still runs', async () => {
  let resolveFirst: ((payload: SessionPayload) => void) | undefined
  const firstResult = new Promise<SessionPayload>((resolve) => {
    resolveFirst = resolve
  })
  const events: string[] = []
  const coordinator = createSessionMutationCoordinator({
    applySession: (payload) => events.push(`apply:${payload.token}`),
    clearSession: () => events.push('clear'),
    refresh: async () => assert.fail('no refresh in this scenario'),
  })

  const first = coordinator.run(() => firstResult)
  const failing = coordinator.run(async () => {
    events.push('mutate:failing')
    throw new Error('queued failure')
  })
  const last = coordinator.run(async () => {
    events.push('mutate:last')
    return sessionPayload('token-last')
  })

  resolveFirst?.(sessionPayload('token-first'))
  assert.equal((await first).token, 'token-first')
  await assert.rejects(failing, /queued failure/)
  assert.equal((await last).token, 'token-last')
  assert.deepEqual(events, [
    'apply:token-first',
    'mutate:failing',
    'mutate:last',
    'apply:token-last',
  ])
})

test('an authentication rejection clears the session and later mutations still run', async () => {
  const events: string[] = []
  const coordinator = createSessionMutationCoordinator({
    applySession: (payload) => events.push(`apply:${payload.token}`),
    clearSession: () => events.push('clear'),
    onTerminal: () => events.push('terminal'),
    refresh: async () => null,
  })

  assert.equal(await coordinator.refresh(), null)
  const after = await coordinator.run(async () => sessionPayload('token-after'))
  assert.equal(after.token, 'token-after')
  // An ordinary refresh null clears but is NOT terminal: the coordinator
  // lives on and no terminal notification ever fires.
  assert.deepEqual(events, ['clear', 'apply:token-after'])
})

