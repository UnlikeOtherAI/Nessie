import assert from 'node:assert/strict'
import test from 'node:test'

import {
  DELIVERY_RETRY_BASE_MS,
  DELIVERY_RETRY_MAX_BACKOFF_MS,
  computeNextRetryAt,
  exponentialBackoffMs,
} from '../src/scheduling.js'

/**
 * The one backoff curve every retry policy in the product is built from. The
 * bases and caps stay with their callers, so what is asserted here is only the
 * shape: doubling from the base, and a ceiling that holds however far the
 * attempts run.
 */

test('the first attempt waits the base and each one after doubles it', () => {
  const curve = [0, 1, 2, 3].map((attempt) =>
    exponentialBackoffMs({ attempt, baseMs: 1000, capMs: 30_000 }),
  )
  assert.deepEqual(curve, [1000, 2000, 4000, 8000])
})

test('the cap holds once doubling would pass it', () => {
  assert.equal(exponentialBackoffMs({ attempt: 5, baseMs: 1000, capMs: 30_000 }), 30_000)
  assert.equal(exponentialBackoffMs({ attempt: 900, baseMs: 1000, capMs: 30_000 }), 30_000)
})

test('a cap below the base is still the cap', () => {
  assert.equal(exponentialBackoffMs({ attempt: 0, baseMs: 60_000, capMs: 1000 }), 1000)
})

test('trigger delivery retries walk that curve from its own base to its own cap', () => {
  const from = new Date('2026-08-11T20:00:00.000Z')
  const waitFor = (retryCount: number) =>
    computeNextRetryAt(retryCount, from).getTime() - from.getTime()

  assert.equal(waitFor(0), DELIVERY_RETRY_BASE_MS)
  assert.equal(waitFor(2), DELIVERY_RETRY_BASE_MS * 4)
  assert.equal(waitFor(10), DELIVERY_RETRY_MAX_BACKOFF_MS)
})

test('a negative stored retry count never shortens the first wait', () => {
  const from = new Date('2026-08-11T20:00:00.000Z')
  assert.equal(
    computeNextRetryAt(-3, from).getTime() - from.getTime(),
    DELIVERY_RETRY_BASE_MS,
  )
})
