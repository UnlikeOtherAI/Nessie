import assert from 'node:assert/strict'
import test, { afterEach, beforeEach } from 'node:test'

import type { AuthSessionState, SessionPayload } from '@nessie/client-core'
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

test('target recovery waits for source restoration and never calls login', async () => {
  const state = await seedPending({
    returnPath: '/channels?filter=mine',
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
    returnPath: '/channels?filter=mine',
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
    const result = await complete({ callback })
    assert.equal(result.returnPath, '/knowledge-base')
    assert.equal(readPendingExternalAuth(), null)
  }
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

test('duplicate callbacks exchange the claimed intent once', async () => {
  const state = await seedPending({})
  let calls = 0
  const run = () => complete({
    callback: envelope('code', state).callback,
    login: async () => {
      calls += 1
      await new Promise((resolve) => setImmediate(resolve))
    },
  })
  const results = await Promise.all([run(), run()])
  assert.equal(calls, 1)
  assert.deepEqual(results.map((result) => result.outcome).sort(), ['completed', 'ignored'])
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
  hub.handleNativeUrl('nessie://auth/callback?code=flow-a')
  await new Promise((resolve) => setImmediate(resolve))
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(logins, 1)

  await seedPending({ targetWorkspace: { organizationId: 'org', teamId: 'team-b' } })
  const flowB = readPendingExternalAuth()
  hub.handleNativeUrl('nessie://auth/callback?code=flow-a')
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(logins, 1)
  assert.deepEqual(readPendingExternalAuth(), flowB)
})
