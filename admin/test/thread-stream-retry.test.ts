import assert from 'node:assert/strict'
import test from 'node:test'

import {
  classifyStreamResponse,
  isTerminalStreamStatus,
  runStreamConnectionLoop,
  streamRetryDelayMs,
  STREAM_RETRY_MAX_MS,
  type StreamAttemptOutcome,
} from '../src/facades/threads/stream-retry.js'

const response = (status: number, body: unknown = 'stream') => ({
  body,
  ok: status >= 200 && status < 300,
  status,
})

// Drive the loop with scripted responses through the same classifier the hook
// uses, recording every sleep so the backoff is observable.
const driveLoop = async (statuses: number[]) => {
  const sleeps: number[] = []
  let index = 0

  await runStreamConnectionLoop({
    attempt: async () => classifyStreamResponse(response(statuses[index++] ?? 403)),
    // Stop once the script is exhausted so a retrying loop still terminates.
    isCancelled: () => index > statuses.length,
    random: () => 0,
    sleep: async (ms) => {
      sleeps.push(ms)
    },
  })

  return { attempts: index, sleeps }
}

test('isTerminalStreamStatus gives up only where reconnecting cannot help', () => {
  assert.equal(isTerminalStreamStatus(403), true)
  assert.equal(isTerminalStreamStatus(404), true)
  for (const status of [200, 401, 408, 429, 500, 502, 503, 504]) {
    assert.equal(isTerminalStreamStatus(status), false, `status ${status}`)
  }
})

test('classifyStreamResponse retries a 500 and a 401, and stops on a 403', () => {
  assert.equal(classifyStreamResponse(response(500, null)), 'failed')
  assert.equal(classifyStreamResponse(response(401, null)), 'failed')
  // A 200 with no body is as useless as a 500 — and just as likely a one-off.
  assert.equal(classifyStreamResponse(response(200, null)), 'failed')
  assert.equal(classifyStreamResponse(response(403, null)), 'terminal')
  assert.equal(classifyStreamResponse(response(404, null)), 'terminal')
  assert.equal(classifyStreamResponse(response(200)), 'connected')
})

test('streamRetryDelayMs backs off exponentially and caps with jitter', () => {
  // Equal jitter: [half, full] of the exponential window.
  assert.equal(streamRetryDelayMs(0, 0), 500)
  assert.equal(streamRetryDelayMs(0, 1), 1_000)
  assert.equal(streamRetryDelayMs(1, 0), 1_000)
  assert.equal(streamRetryDelayMs(3, 1), 8_000)

  // Capped, never unbounded, and never below half the cap once saturated.
  assert.equal(streamRetryDelayMs(20, 1), STREAM_RETRY_MAX_MS)
  assert.equal(streamRetryDelayMs(20, 0), STREAM_RETRY_MAX_MS / 2)

  for (let attempt = 0; attempt < 12; attempt += 1) {
    const delay = streamRetryDelayMs(attempt)
    assert.ok(delay > 0 && delay <= STREAM_RETRY_MAX_MS, `attempt ${attempt} => ${delay}`)
  }
})

test('a 500 reconnects with growing backoff instead of ending the stream', async () => {
  const { attempts, sleeps } = await driveLoop([500, 500, 500, 502])

  assert.equal(attempts, 5, 'kept reconnecting past the first failure')
  assert.deepEqual(sleeps, [500, 1_000, 2_000, 4_000])
})

test('a 403 ends the loop immediately without sleeping', async () => {
  const { attempts, sleeps } = await driveLoop([403])

  assert.equal(attempts, 1)
  assert.deepEqual(sleeps, [])
})

test('a 401 during token rotation is retried, not fatal', async () => {
  const { attempts, sleeps } = await driveLoop([401, 200])

  assert.equal(attempts, 3, 'reconnected after the 401 and connected')
  assert.deepEqual(sleeps, [500, 500], 'the successful connection reset the backoff')
})

test('an established connection resets the backoff', async () => {
  const { sleeps } = await driveLoop([500, 500, 500, 200, 500])

  // Without the reset the fourth wait would be 8s and the fifth 16s; the
  // successful connection puts the ladder back on its bottom rung.
  assert.deepEqual(sleeps, [500, 1_000, 2_000, 500, 1_000])
})

test('a thrown attempt is treated as transient', async () => {
  const sleeps: number[] = []
  let attempts = 0

  await runStreamConnectionLoop({
    attempt: async () => {
      attempts += 1
      if (attempts < 3) {
        throw new Error('network down')
      }
      return 'terminal' satisfies StreamAttemptOutcome
    },
    isCancelled: () => false,
    random: () => 0,
    sleep: async (ms) => {
      sleeps.push(ms)
    },
  })

  assert.equal(attempts, 3)
  assert.deepEqual(sleeps, [500, 1_000])
})

test('cancellation stops the loop without another attempt', async () => {
  let attempts = 0
  let cancelled = false

  await runStreamConnectionLoop({
    attempt: async () => {
      attempts += 1
      cancelled = true
      return 'failed' satisfies StreamAttemptOutcome
    },
    isCancelled: () => cancelled,
    random: () => 0,
    sleep: async () => {
      assert.fail('a cancelled loop must not wait to reconnect')
    },
  })

  assert.equal(attempts, 1)
})
