import assert from 'node:assert/strict'
import test from 'node:test'

import {
  DEFAULT_UPSTREAM_PACING,
  drawUpstreamCeilingMs,
  UPSTREAM_RATE_LIMITS,
  type UpstreamPacing,
} from '../src/control/automatic-membership/rate-limit.js'

/**
 * The pacing policy itself, with no database in it.
 *
 * The ceiling used to be one constant, `MAX_WAIT_MS = 30_000`. A constant is a
 * deadline every waiter agrees on: a sweep that co-launches a hundred
 * reconciliation jobs parks all hundred against a saturated cap and discharges
 * them in one spike thirty seconds later — the thundering herd the
 * deployment-wide cap exists to prevent, arriving through the ceiling instead
 * of through the cap. The spread below is what stops that; the counted
 * overshoot allowance (see the database suite) is what bounds the rate once
 * waiters are through it.
 */

test('each call draws its own ceiling, so co-launched waiters share no deadline', () => {
  const draws = Array.from({ length: 500 }, () => drawUpstreamCeilingMs())

  for (const draw of draws) {
    assert.ok(
      draw >= DEFAULT_UPSTREAM_PACING.minCeilingMs
      && draw < DEFAULT_UPSTREAM_PACING.maxCeilingMs,
      `a ceiling of ${draw}ms is outside `
      + `[${DEFAULT_UPSTREAM_PACING.minCeilingMs}, ${DEFAULT_UPSTREAM_PACING.maxCeilingMs})`,
    )
  }

  // A shared constant would collapse to one. The bound is deliberately far
  // below 500 so this measures "spread at all", not the quality of Math.random.
  assert.ok(
    new Set(draws).size > 100,
    `500 co-launched waiters drew ${new Set(draws).size} distinct ceiling(s); a `
    + 'ceiling every waiter agrees on is a synchronised discharge',
  )
})

test('the hard stop inherits the draw rather than re-synchronising after it', () => {
  // The ceiling is jittered but the hard stop is a fixed 4 × 30 s, every waiter
  // would agree on 120 s and the spike would simply move later. Expressing it
  // as a multiple of this call's own draw is what keeps the spread.
  const pacing: UpstreamPacing = DEFAULT_UPSTREAM_PACING
  const hardStops = Array.from(
    { length: 500 },
    () => drawUpstreamCeilingMs(pacing) * pacing.hardCeilingMultiple,
  )

  assert.ok(new Set(hardStops).size > 100, 'the hard stop collapsed to one deadline')
  // Still inside the queue's 300 s lock TTL at the top of the range.
  assert.ok(
    Math.max(...hardStops) < 300_000,
    `a hard stop of ${Math.max(...hardStops)}ms would outlast the queue's lock TTL`,
  )
})

test('a degenerate pacing window draws its floor rather than a NaN', () => {
  // `maxCeilingMs === minCeilingMs` is a legitimate way to pin the ceiling in a
  // test; it must not produce a negative spread.
  const pinned: UpstreamPacing = {
    hardCeilingMultiple: 2,
    maxCeilingMs: 250,
    minCeilingMs: 250,
  }
  assert.equal(drawUpstreamCeilingMs(pinned), 250)
})

test('the overshoot allowance is a fraction of the cap it extends', () => {
  // If the ceiling's own lane were as wide as the cap, the cap would be a
  // suggestion. Stated here so a future widening has to argue with a test.
  assert.ok(
    UPSTREAM_RATE_LIMITS.overshoot.max * 4 <= UPSTREAM_RATE_LIMITS.deployment.max,
    `an overshoot allowance of ${UPSTREAM_RATE_LIMITS.overshoot.max}/window against a `
    + `deployment cap of ${UPSTREAM_RATE_LIMITS.deployment.max}/window is not an overshoot`,
  )
  assert.equal(
    UPSTREAM_RATE_LIMITS.overshoot.windowMs,
    UPSTREAM_RATE_LIMITS.deployment.windowMs,
    'the two caps must be summable, which means they must share a window',
  )
})
