import assert from 'node:assert/strict'
import test from 'node:test'

import { createBrowserbaseClient } from '../src/browserbase-client.js'

test('release waits for Browserbase to confirm a terminal session state', async () => {
  const requests: Array<{ method: string; url: string }> = []
  let reads = 0
  const client = createBrowserbaseClient({ apiKey: 'key' }, {
    fetchImpl: (async (url: string, init?: { method?: string }) => {
      requests.push({ method: init?.method ?? 'GET', url })
      if (init?.method === 'POST') return new Response('{}', { status: 200 })
      reads += 1
      return new Response(JSON.stringify({ status: reads === 1 ? 'REQUEST_RELEASE' : 'COMPLETED' }), { status: 200 })
    }) as never,
    releaseConfirmDelayMs: 0,
    sleep: async () => undefined,
  })

  await client.endSession('session-1')

  assert.deepEqual(requests.map((request) => request.method), ['POST', 'GET', 'GET'])
  assert.ok(requests.every((request) => request.url.endsWith('/v1/sessions/session-1')))
})

test('release refuses to call a session stopped until Browserbase confirms it', async () => {
  const client = createBrowserbaseClient({ apiKey: 'key' }, {
    fetchImpl: (async () => new Response(JSON.stringify({ status: 'REQUEST_RELEASE' }), { status: 200 })) as never,
    releaseConfirmAttempts: 2,
    releaseConfirmDelayMs: 0,
    sleep: async () => undefined,
  })

  await assert.rejects(
    client.endSession('session-1'),
    (error: Error & { code?: string }) => error.code === 'CLOUD_BROWSER_UNREACHABLE',
  )
})
