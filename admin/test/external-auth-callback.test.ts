import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createExternalAuthCallbackHub,
  parseNativeAuthCallbackUrl,
  parseWebAuthCallbackUrl,
} from '../src/providers/external-auth-callback.js'

test('native and web parsers accept code, cancellation and provider errors', () => {
  assert.deepEqual(
    parseNativeAuthCallbackUrl('nessie://auth/callback?code=abc&state=s'),
    { code: 'abc', kind: 'code', state: 's' },
  )
  assert.deepEqual(
    parseNativeAuthCallbackUrl('nessie://auth/callback?error=access_denied&state=s'),
    { kind: 'cancelled', state: 's' },
  )
  assert.deepEqual(
    parseNativeAuthCallbackUrl('nessie://auth/callback?error=server_error'),
    { error: 'server_error', kind: 'provider-error', state: null },
  )
  assert.deepEqual(
    parseWebAuthCallbackUrl('https://app.example/login?code=abc', 'https://app.example'),
    {
      callback: { code: 'abc', kind: 'code', state: null },
      redirectUri: 'https://app.example/login',
    },
  )
  assert.equal(
    parseWebAuthCallbackUrl('https://evil.example/login?code=abc', 'https://app.example'),
    null,
  )
})

test('strict callback parsers reject malformed and duplicated parameters', () => {
  for (const url of [
    'nessie://user@auth/callback?code=a',
    'nessie://auth:8443/callback?code=a',
    'nessie://auth/callback?code=a#fragment',
    'nessie://auth/callback/extra?code=a',
    'nessie://auth/callback?code=a&code=b',
    'nessie://auth/callback?code=a&error=access_denied',
    `nessie://auth/callback?code=${'x'.repeat(513)}`,
  ]) {
    assert.equal(parseNativeAuthCallbackUrl(url), null, url)
  }
})

test('hub buffers until ready and serializes completions', async () => {
  const events: string[] = []
  let releaseFirst: (() => void) | undefined
  const firstBlocked = new Promise<void>((resolve) => { releaseFirst = resolve })
  const hub = createExternalAuthCallbackHub(async (envelope) => {
    const code = envelope.callback.kind === 'code' ? envelope.callback.code : 'error'
    events.push(`start:${code}`)
    if (code === 'one') await firstBlocked
    events.push(`end:${code}`)
    return true
  })
  const first = hub.handleNativeUrl('nessie://auth/callback?code=one&state=s1')
  const second = hub.handleNativeUrl('nessie://auth/callback?code=two&state=s2')
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(events, [])

  hub.setReady(true)
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(events, ['start:one'])
  releaseFirst?.()
  await Promise.all([first, second])
  assert.deepEqual(events, ['start:one', 'end:one', 'start:two', 'end:two'])
})

test('hub dedupes only after the first completion claims the intent', async () => {
  let calls = 0
  const hub = createExternalAuthCallbackHub(async () => {
    calls += 1
    return true
  })
  hub.setReady(true)
  await Promise.all([
    hub.handleNativeUrl('nessie://auth/callback?code=one&state=s1'),
    hub.handleNativeUrl('nessie://auth/callback?code=one&state=s1'),
  ])
  assert.equal(calls, 1)

  const notClaimedHub = createExternalAuthCallbackHub(async () => {
    calls += 1
    return false
  })
  notClaimedHub.setReady(true)
  await Promise.all([
    notClaimedHub.handleNativeUrl('nessie://auth/callback?code=stale&state=old'),
    notClaimedHub.handleNativeUrl('nessie://auth/callback?code=stale&state=old'),
  ])
  assert.equal(calls, 3)
})

test('hub rejects an uncompleted delivery so native transport can redeliver it', async () => {
  const hub = createExternalAuthCallbackHub(async () => {
    throw new Error('page unloaded')
  })
  hub.setReady(true)
  await assert.rejects(
    hub.handleNativeUrl('nessie://auth/callback?code=one&state=s1'),
    /page unloaded/,
  )
})

test('a rejected native callback settles visibly without recording a replay key', async () => {
  let completions = 0
  let invalidCallbacks = 0
  const remembered: string[] = []
  const hub = createExternalAuthCallbackHub(
    async () => {
      completions += 1
      return true
    },
    { has: () => false, remember: (key) => remembered.push(key) },
    async () => { invalidCallbacks += 1 },
  )

  await hub.handleNativeUrl('nessie://auth/not-a-callback?code=one')

  assert.equal(completions, 0)
  assert.equal(invalidCallbacks, 1)
  assert.deepEqual(remembered, [])
})

test('queue overflow rejects the incoming delivery without acknowledging queued callbacks', async () => {
  const completed: string[] = []
  const hub = createExternalAuthCallbackHub(async (envelope) => {
    if (envelope.callback.kind === 'code') completed.push(envelope.callback.code)
    return true
  })
  const queued = ['one', 'two', 'three', 'four'].map((code) =>
    hub.handleNativeUrl(`nessie://auth/callback?code=${code}&state=${code}`))
  await assert.rejects(
    hub.handleNativeUrl('nessie://auth/callback?code=overflow&state=overflow'),
    /queue is full/,
  )
  assert.deepEqual(completed, [])

  hub.setReady(true)
  await Promise.all(queued)
  assert.deepEqual(completed, ['one', 'two', 'three', 'four'])
})
