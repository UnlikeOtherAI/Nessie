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
  hub.handleNativeUrl('nessie://auth/callback?code=one&state=s1')
  hub.handleNativeUrl('nessie://auth/callback?code=two&state=s2')
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(events, [])

  hub.setReady(true)
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(events, ['start:one'])
  releaseFirst?.()
  await new Promise((resolve) => setImmediate(resolve))
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(events, ['start:one', 'end:one', 'start:two', 'end:two'])
})

test('hub dedupes only after the first completion claims the intent', async () => {
  let calls = 0
  const hub = createExternalAuthCallbackHub(async () => {
    calls += 1
    return true
  })
  hub.setReady(true)
  hub.handleNativeUrl('nessie://auth/callback?code=one&state=s1')
  hub.handleNativeUrl('nessie://auth/callback?code=one&state=s1')
  await new Promise((resolve) => setImmediate(resolve))
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(calls, 1)

  const notClaimedHub = createExternalAuthCallbackHub(async () => {
    calls += 1
    return false
  })
  notClaimedHub.setReady(true)
  notClaimedHub.handleNativeUrl('nessie://auth/callback?code=stale&state=old')
  notClaimedHub.handleNativeUrl('nessie://auth/callback?code=stale&state=old')
  await new Promise((resolve) => setImmediate(resolve))
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(calls, 3)
})
