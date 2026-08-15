import assert from 'node:assert/strict'
import test, { afterEach, beforeEach } from 'node:test'

import {
  createCompletedExternalAuthCallbackCache,
  type AuthSessionState,
  type PkceStorage,
  type SessionPayload,
} from '@nessie/client-core'
import { completeExternalAuthCallback } from '../src/lib/external-auth-completion.js'
import { createExternalAuthCallbackHub } from '../src/providers/external-auth-callback.js'
import {
  beginExternalAuth,
  clearPendingExternalAuth,
  readPendingExternalAuth,
} from '../src/lib/pkce.js'

beforeEach(() => clearPendingExternalAuth())
const realFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = realFetch
  clearPendingExternalAuth()
})

const seedPending = async (input: {
  returnPath?: string
  targetWorkspace?: { organizationId: string; teamId: string }
}): Promise<string> => {
  globalThis.fetch = (async () =>
    Response.json({ data: { authorizeUrl: 'https://idp.example/auth' } })) as typeof fetch
  await beginExternalAuth({
    origin: 'https://app.example',
    providerId: 'uoa',
    redirectUri: 'nessie://auth/callback',
    theme: 'dark',
    ...input,
  })
  const pending = readPendingExternalAuth()
  assert.ok(pending)
  return pending.state
}

const payload = (): SessionPayload => ({ me: {} as SessionPayload['me'], token: 'token' })
const envelope = (code: string, state: string | null) => ({
  callback: { code, kind: 'code' as const, state },
  redirectUri: 'nessie://auth/callback',
})

const complete = (input: {
  callback: ReturnType<typeof envelope>['callback'] | { kind: 'cancelled'; state: string | null }
    | { error: string; kind: 'provider-error'; state: string | null }
  login?: () => Promise<void>
  recovery?: () => Promise<SessionPayload>
  ready?: () => Promise<AuthSessionState>
}) => completeExternalAuthCallback({
  envelope: { callback: input.callback, redirectUri: 'nessie://auth/callback' },
  login: input.login ?? (async () => undefined),
  recoveryExchange: input.recovery ?? (async () => payload()),
  waitForSessionReady: input.ready ?? (async () => 'authenticated'),
})

test('stale callback is ignored without exchanging', async () => {
  let calls = 0
  const result = await complete({
    callback: envelope('code', null).callback,
    login: async () => { calls += 1 },
  })
  assert.deepEqual(result, { claimed: false, outcome: 'ignored' })
  assert.equal(calls, 0)
})

test('mismatched state preserves a newer target intent', async () => {
  await seedPending({
    returnPath: '/projects',
    targetWorkspace: { organizationId: 'org', teamId: 'team' },
  })
  const pending = readPendingExternalAuth()
  const result = await complete({ callback: envelope('code', 'stale').callback })
  assert.equal(result.outcome, 'state-mismatch')
  assert.deepEqual(readPendingExternalAuth(), pending)
})

test('ordinary callback uses login and returns the clean login landing', async () => {
  const state = await seedPending({})
  let logins = 0
  const result = await complete({
    callback: envelope('code', state).callback,
    login: async () => { logins += 1 },
  })
  assert.deepEqual(result, { claimed: true, outcome: 'completed', returnPath: '/channels' })
  assert.equal(logins, 1)
})

test('a completed switch lands on the home every workspace has', async () => {
  const state = await seedPending({
    returnPath: '/channels/chan-from-old-workspace',
    targetWorkspace: { organizationId: 'org', teamId: 'team' },
  })
  const result = await complete({ callback: envelope('code', state).callback })
  assert.deepEqual(result, { claimed: true, outcome: 'completed', returnPath: '/channels' })
})

test('a plain re-login still honours its own landing route', async () => {
  const state = await seedPending({ returnPath: '/projects/p1' })
  const result = await complete({ callback: envelope('code', state).callback })
  assert.deepEqual(result, { claimed: true, outcome: 'completed', returnPath: '/projects/p1' })
})

test('target recovery waits for source restoration and never calls login', async () => {
  const state = await seedPending({
    returnPath: '/channels/chan-a',
    targetWorkspace: { organizationId: 'org', teamId: 'team' },
  })
  let resolveReady: ((state: AuthSessionState) => void) | undefined
  const ready = new Promise<AuthSessionState>((resolve) => { resolveReady = resolve })
  const events: string[] = []
  const completion = complete({
    callback: envelope('code', state).callback,
    login: async () => { events.push('login') },
    ready: () => ready,
    recovery: async () => {
      events.push('recovery')
      return payload()
    },
  })
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(events, [])
  resolveReady?.('authenticated')
  assert.deepEqual(await completion, {
    claimed: true,
    outcome: 'completed',
    returnPath: '/channels',
  })
  assert.deepEqual(events, ['recovery'])
})

test('unauthenticated source fails targeted recovery without ordinary login', async () => {
  const state = await seedPending({
    returnPath: '/projects',
    targetWorkspace: { organizationId: 'org', teamId: 'team' },
  })
  let calls = 0
  const result = await complete({
    callback: envelope('code', state).callback,
    login: async () => { calls += 1 },
    ready: async () => 'unauthenticated',
    recovery: async () => {
      calls += 1
      return payload()
    },
  })
  assert.equal(result.outcome, 'failed')
  assert.equal(calls, 0)
})

test('target cancellation and provider error preserve the stored route', async () => {
  for (const callback of [
    { kind: 'cancelled' as const, state: null },
    { error: 'server_error', kind: 'provider-error' as const, state: null },
  ]) {
    await seedPending({
      returnPath: '/knowledge-base',
      targetWorkspace: { organizationId: 'org', teamId: 'team' },
    })
    let exchanges = 0
    const result = await complete({
      callback,
      login: async () => { exchanges += 1 },
      recovery: async () => {
        exchanges += 1
        return payload()
      },
    })
    // Nothing changed, so the person stays exactly where they were standing.
    assert.equal(result.returnPath, '/knowledge-base')
    assert.equal(exchanges, 0)
    assert.equal(readPendingExternalAuth(), null)
  }
})

test('a failed targeted exchange returns to the originating route', async () => {
  const state = await seedPending({
    returnPath: '/channels/chan-a/threads/t-1',
    targetWorkspace: { organizationId: 'org', teamId: 'team' },
  })
  const result = await complete({
    callback: envelope('code', state).callback,
    recovery: async () => { throw new Error('upstream refused') },
  })
  assert.equal(result.outcome, 'failed')
  assert.equal(
    result.outcome === 'failed' ? result.returnPath : null,
    '/channels/chan-a/threads/t-1',
  )
})

test('exchange errors are bounded and unsafe return paths fall back safely', async () => {
  const state = await seedPending({
    returnPath: '//evil.example',
    targetWorkspace: { organizationId: 'org', teamId: 'team' },
  })
  const result = await complete({
    callback: envelope('code', state).callback,
    recovery: async () => { throw new Error('secret upstream diagnostic') },
  })
  assert.equal(result.outcome, 'failed')
  if (result.outcome === 'failed') {
    assert.equal(result.message, 'The external sign-in could not be completed.')
    assert.equal(result.returnPath, '/channels')
  }
})

test('callback hub serializes duplicate callbacks and exchanges once', async () => {
  const state = await seedPending({})
  let calls = 0
  const outcomes: string[] = []
  const hub = createExternalAuthCallbackHub(async (callbackEnvelope) => {
    const result = await completeExternalAuthCallback({
      envelope: callbackEnvelope,
      login: async () => {
        calls += 1
        await new Promise((resolve) => setImmediate(resolve))
      },
      recoveryExchange: async () => payload(),
      waitForSessionReady: async () => 'authenticated',
    })
    outcomes.push(result.outcome)
    return result.claimed
  })
  hub.setReady(true)
  await Promise.all([
    hub.handleNativeUrl(`nessie://auth/callback?code=flow&state=${state}`),
    hub.handleNativeUrl(`nessie://auth/callback?code=flow&state=${state}`),
  ])
  assert.equal(calls, 1)
  assert.deepEqual(outcomes, ['completed'])
})

test('a remembered state-less UOA callback cannot claim a later flow', async () => {
  let logins = 0
  const hub = createExternalAuthCallbackHub(async (callbackEnvelope) => {
    const result = await completeExternalAuthCallback({
      envelope: callbackEnvelope,
      login: async () => { logins += 1 },
      recoveryExchange: async () => payload(),
      waitForSessionReady: async () => 'authenticated',
    })
    return result.claimed
  })
  hub.setReady(true)
  await seedPending({})
  await hub.handleNativeUrl('nessie://auth/callback?code=flow-a')
  assert.equal(logins, 1)

  await seedPending({ targetWorkspace: { organizationId: 'org', teamId: 'team-b' } })
  const flowB = readPendingExternalAuth()
  await hub.handleNativeUrl('nessie://auth/callback?code=flow-a')
  assert.equal(logins, 1)
  assert.deepEqual(readPendingExternalAuth(), flowB)
})

test('lost native ack cannot let a completed state-less callback claim the next flow after remount', async () => {
  const sessionEntries = new Map<string, string>()
  const recreateSessionStorage = (): PkceStorage => ({
    getItem: (key) => sessionEntries.get(key) ?? null,
    removeItem: (key) => { sessionEntries.delete(key) },
    setItem: (key, value) => { sessionEntries.set(key, value) },
  })
  let logins = 0
  const completeEnvelope = async (callbackEnvelope: ReturnType<typeof envelope>): Promise<boolean> => {
    const result = await completeExternalAuthCallback({
      envelope: callbackEnvelope,
      login: async () => { logins += 1 },
      recoveryExchange: async () => payload(),
      waitForSessionReady: async () => 'authenticated',
    })
    return result.claimed
  }

  await seedPending({})
  const callbackA = 'nessie://auth/callback?code=flow-a'
  const firstHub = createExternalAuthCallbackHub(
    completeEnvelope,
    createCompletedExternalAuthCallbackCache(recreateSessionStorage()),
  )
  firstHub.setReady(true)
  await firstHub.handleNativeUrl(callbackA)
  assert.equal(logins, 1)
  assert.equal(readPendingExternalAuth(), null)

  // The native delivery ack is lost while the WebView remounts. B may now
  // begin, but the retained state-less A callback is delivered again first.
  const stateB = await seedPending({})
  const pendingB = readPendingExternalAuth()
  const recreatedHub = createExternalAuthCallbackHub(
    completeEnvelope,
    createCompletedExternalAuthCallbackCache(recreateSessionStorage()),
  )
  recreatedHub.setReady(true)
  await recreatedHub.handleNativeUrl(callbackA)
  assert.equal(logins, 1)
  assert.deepEqual(readPendingExternalAuth(), pendingB)

  await recreatedHub.handleNativeUrl(`nessie://auth/callback?code=flow-b&state=${stateB}`)
  assert.equal(logins, 2)
  assert.equal(readPendingExternalAuth(), null)
})

test('a recreated hub can finish an interrupted web callback without wedging the intent', async () => {
  const state = await seedPending({})
  let releaseInterrupted: (() => void) | undefined
  const interrupted = new Promise<boolean>((resolve) => { releaseInterrupted = () => resolve(true) })
  const firstHub = createExternalAuthCallbackHub(() => interrupted)
  firstHub.setReady(true)
  void firstHub.handleWebUrl(
    `https://app.example/login?code=flow-a&state=${state}`,
    'https://app.example',
  )
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(readPendingExternalAuth()?.state, state)
  await assert.rejects(seedPending({}), /already in progress/)

  let logins = 0
  const recreatedHub = createExternalAuthCallbackHub(async (callbackEnvelope) => {
    const result = await completeExternalAuthCallback({
      envelope: callbackEnvelope,
      login: async () => { logins += 1 },
      recoveryExchange: async () => payload(),
      waitForSessionReady: async () => 'authenticated',
    })
    return result.claimed
  })
  recreatedHub.setReady(true)
  await recreatedHub.handleWebUrl(
    `https://app.example/login?code=flow-a&state=${state}`,
    'https://app.example',
  )
  assert.equal(logins, 1)
  assert.equal(readPendingExternalAuth(), null)
  await seedPending({})
  assert.ok(readPendingExternalAuth())
  releaseInterrupted?.()
})
