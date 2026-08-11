import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildNextScheduledRunAt,
  computeInitialScheduleRunAt,
  parseScheduleUntil,
} from '../src/scheduling.js'

/**
 * `config.until` ends a recurring schedule ("watch this until 9am tomorrow").
 *
 * Returning null is the existing stop signal — it clears `next_run_at`, and the
 * scheduler only claims rows where that column is set — so these assert the
 * null, which is the whole mechanism.
 */

const NOW = new Date('2026-08-11T20:00:00.000Z')
const interval = (until?: string) => ({
  interval_minutes: 15,
  ...(until ? { until } : {}),
})

test('a fire inside the window is scheduled normally', () => {
  const next = buildNextScheduledRunAt({
    config: interval('2026-08-12T09:00:00.000Z'),
    from: NOW,
    now: NOW,
    type: 'interval',
  })
  assert.deepEqual(next, new Date('2026-08-11T20:15:00.000Z'))
})

test('the fire that would land past the end stops the schedule', () => {
  const next = buildNextScheduledRunAt({
    config: interval('2026-08-11T20:10:00.000Z'),
    from: NOW,
    now: NOW,
    type: 'interval',
  })
  assert.equal(next, null)
})

test('an already-lapsed schedule is never armed in the first place', () => {
  assert.equal(
    computeInitialScheduleRunAt({
      config: interval('2026-08-11T19:00:00.000Z'),
      now: NOW,
      type: 'interval',
    }),
    null,
  )
})

test('a cron schedule honours the same end', () => {
  const config = { cron: '*/15 * * * *', until: '2026-08-11T20:05:00.000Z' }
  assert.equal(
    buildNextScheduledRunAt({ config, from: NOW, now: NOW, type: 'scheduled' }),
    null,
  )
  assert.ok(
    buildNextScheduledRunAt({
      config: { cron: '*/15 * * * *', until: '2026-08-12T09:00:00.000Z' },
      from: NOW,
      now: NOW,
      type: 'scheduled',
    }) instanceof Date,
  )
})

test('no end means it runs forever, exactly as before', () => {
  assert.deepEqual(
    buildNextScheduledRunAt({
      config: interval(),
      from: NOW,
      now: NOW,
      type: 'interval',
    }),
    new Date('2026-08-11T20:15:00.000Z'),
  )
})

test('a malformed end is ignored rather than silently stopping the schedule', () => {
  for (const bad of ['not-a-date', '', 42, null, undefined]) {
    assert.equal(parseScheduleUntil({ interval_minutes: 15, until: bad }), null)
    assert.ok(
      buildNextScheduledRunAt({
        config: { interval_minutes: 15, until: bad },
        from: NOW,
        now: NOW,
        type: 'interval',
      }) instanceof Date,
      `until=${String(bad)} must not stop the schedule`,
    )
  }
})

test('parseScheduleUntil reads a valid ISO end', () => {
  assert.deepEqual(
    parseScheduleUntil({ until: '2026-08-12T09:00:00.000Z' }),
    new Date('2026-08-12T09:00:00.000Z'),
  )
})
