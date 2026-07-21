import assert from 'node:assert/strict'
import { test } from 'node:test'

import { SlackApiError, SlackClient } from '../src/client.js'
import type { FetchLike } from '../src/types.js'

const clientWith = (fetchImpl: FetchLike, maxRetries = 0): SlackClient =>
  new SlackClient({
    fetchImpl,
    sleep: () => Promise.resolve(),
    maxRetries,
    retryAfterCapMs: 60_000,
  })

test('classifies HTTP 429 as retryable and surfaces Retry-After', async () => {
  const client = clientWith(
    (async () =>
      new Response('', {
        status: 429,
        headers: { 'retry-after': '3' },
      })) as unknown as FetchLike,
  )

  await assert.rejects(
    () => client.call({ method: 'conversations.history', token: 't' }),
    (error: unknown) => {
      assert.ok(error instanceof SlackApiError)
      assert.equal(error.code, 'ratelimited')
      assert.equal(error.retryable, true)
      assert.equal(error.retryAfterMs, 3000)
      return true
    },
  )
})

test('retries a 429 then succeeds within maxRetries', async () => {
  let calls = 0
  const client = clientWith(
    (async () => {
      calls += 1
      if (calls === 1) {
        return new Response('', {
          status: 429,
          headers: { 'retry-after': '1' },
        })
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 })
    }) as unknown as FetchLike,
    2,
  )

  const result = await client.call({ method: 'auth.test', token: 't' })
  assert.equal(result.ok, true)
  assert.equal(calls, 2)
})

test('classifies invalid_auth as fatal + needs-reauthorization', async () => {
  const client = clientWith(
    (async () =>
      new Response(JSON.stringify({ ok: false, error: 'invalid_auth' }), {
        status: 200,
      })) as unknown as FetchLike,
  )

  await assert.rejects(
    () => client.call({ method: 'auth.test', token: 't' }),
    (error: unknown) => {
      assert.ok(error instanceof SlackApiError)
      assert.equal(error.code, 'invalid_auth')
      assert.equal(error.retryable, false)
      assert.equal(error.needsReauthorization, true)
      return true
    },
  )
})

test('classifies HTTP 5xx as retryable', async () => {
  const client = clientWith(
    (async () => new Response('', { status: 503 })) as unknown as FetchLike,
  )

  await assert.rejects(
    () => client.call({ method: 'conversations.history', token: 't' }),
    (error: unknown) =>
      error instanceof SlackApiError
      && error.retryable === true
      && error.code === 'server_error',
  )
})
