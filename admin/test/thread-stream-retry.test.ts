import assert from 'node:assert/strict'
import test from 'node:test'

import {
  classifyStreamResponse,
  isTerminalStreamStatus,
  runStreamConnectionLoop,
  streamRetryDelayMs,
  STREAM_HEALTHY_CONNECTION_MS,
  STREAM_RETRY_MAX_MS,
  type StreamAttemptOutcome,
} from '../src/facades/threads/stream-retry.js'

const response = (status: number, body: unknown = 'stream') => ({
  body,
  ok: status >= 200 && status < 300,
  status,
})

/**
 * Drive the loop with scripted responses through the same classifier the hook
 * uses, recording every sleep so the backoff is observable.
 *
 * `lastedMs` is how long that connect-and-drain cycle takes on the loop's own
 * clock, which is what decides whether an established connection resets the
 * ladder. A step written as a bare status lasted a healthy window, so the
 * cases that predate the five-second rule still say what they meant.
 */
type ScriptedAttempt = number | { lastedMs: number; status: number }

const driveLoop = async (script: ScriptedAttempt[]) => {
  const sleeps: number[] = []
  let index = 0
  let clock = 0

  await runStreamConnectionLoop({
    attempt: async () => {
      const step = script[index++]
      clock +=
        typeof step === 'object' ? step.lastedMs : STREAM_HEALTHY_CONNECTION_MS
      return classifyStreamResponse(response(typeof step === 'object' ? step.status : step ?? 403))
    },
    // Stop once the script is exhausted so a retrying loop still terminates.
    isCancelled: () => index > script.length,
    now: () => clock,
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

test('a connection that did real work resets the backoff', async () => {
  const { sleeps } = await driveLoop([500, 500, 500, 200, 500])

  // Without the reset the fourth wait would be 8s and the fifth 16s; a
  // connection that outlived the healthy window puts the ladder back on its
  // bottom rung.
  assert.deepEqual(sleeps, [500, 1_000, 2_000, 500, 1_000])
})

test('a connection that dies inside five seconds escalates instead of resetting', async () => {
  // A replica draining under a scale-in: the socket opens, the server hands it
  // back a stream and then goes away. Every cycle "connected"; none of them did
  // any work. With the old rule — reset on any `connected` — this was
  // [500, 500, 500, 500, 500] forever, which is 200 clients knocking on the
  // survivors once a second while those survivors absorb the drained load.
  const shortLived = { lastedMs: 200, status: 200 }
  const { sleeps } = await driveLoop([
    shortLived,
    shortLived,
    shortLived,
    shortLived,
    shortLived,
  ])

  assert.deepEqual(sleeps, [500, 1_000, 2_000, 4_000, 8_000])
})

test('the healthy window is a floor, not a target', async () => {
  // One millisecond short does not count; exactly the window does. Pinned so
  // the boundary cannot drift into "almost anything resets" by accident.
  const justShort = await driveLoop([
    { lastedMs: STREAM_HEALTHY_CONNECTION_MS - 1, status: 200 },
    { lastedMs: STREAM_HEALTHY_CONNECTION_MS - 1, status: 200 },
  ])
  assert.deepEqual(justShort.sleeps, [500, 1_000])

  const exactly = await driveLoop([
    { lastedMs: STREAM_HEALTHY_CONNECTION_MS, status: 200 },
    { lastedMs: STREAM_HEALTHY_CONNECTION_MS, status: 200 },
  ])
  assert.deepEqual(exactly.sleeps, [500, 500])
})

test('a healthy connection resets, and churn after it escalates again', async () => {
  // The mixed case a drain actually produces: the client recovers onto a
  // survivor, works for a while, then that survivor sheds it too. The good
  // connection earns its reset; the short ones that follow must not hold the
  // ladder on its bottom rung.
  const { sleeps } = await driveLoop([
    500,
    500,
    { lastedMs: 30_000, status: 200 },
    { lastedMs: 100, status: 200 },
    { lastedMs: 100, status: 200 },
  ])

  assert.deepEqual(sleeps, [500, 1_000, 500, 1_000, 2_000])
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

// Collect the first reconnect delay of `count` clients that all lost their
// connection at the same instant — one replica draining onto its survivors —
// through the real loop with the real `Math.random`.
const drawFirstDelays = async (count: number): Promise<number[]> => {
  const delays: number[] = []

  for (let client = 0; client < count; client += 1) {
    let attempts = 0
    await runStreamConnectionLoop({
      attempt: async () => (attempts++ === 0 ? 'failed' : 'terminal'),
      isCancelled: () => false,
      sleep: async (ms) => {
        delays.push(ms)
      },
    })
  }

  return delays
}

test('clients cut loose together draw distinct delays, not one shared instant', async () => {
  const delays = await drawFirstDelays(200)
  assert.equal(delays.length, 200)

  // A constant — jitter removed, or a shared ceiling every waiter agrees on —
  // collapses this to a single value. Uniform draws over the 501 ms window
  // average ~165 distinct values for 200 clients, so 100 is far below the
  // noise floor and far above a constant.
  const distinct = new Set(delays)
  assert.ok(distinct.size >= 100, `only ${distinct.size} distinct delays across 200 clients`)

  // And they cover the window rather than piling on one edge of it.
  assert.ok(Math.min(...delays) < 600, `earliest was ${Math.min(...delays)}`)
  assert.ok(Math.max(...delays) > 900, `latest was ${Math.max(...delays)}`)
  for (const delay of delays) {
    assert.ok(delay >= 500 && delay <= 1_000, `${delay} outside the first window`)
  }
})

test('the ceiling is drawn too, so a saturated herd does not discharge together', () => {
  // The trap this program has already been bitten by: escalation is worthless
  // if every waiter that reaches the cap agrees on the same instant. Saturated
  // clients must still spread across [max/2, max].
  const delays = Array.from({ length: 200 }, () => streamRetryDelayMs(20))

  assert.ok(new Set(delays).size >= 100, 'the cap is a window, not a constant')
  assert.ok(Math.min(...delays) < STREAM_RETRY_MAX_MS * 0.6)
  assert.ok(Math.max(...delays) > STREAM_RETRY_MAX_MS * 0.9)
})
