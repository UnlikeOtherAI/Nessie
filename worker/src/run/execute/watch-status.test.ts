import assert from 'node:assert/strict'
import test from 'node:test'

import {
  classifyWatchDisposition,
  isRollingStatusEnabled,
  readWatchStatus,
} from './watch-status.js'

/**
 * The rolling status must never swallow a finding. Every ambiguous or broken
 * answer has to fall back to posting — a redundant message is a nuisance, a
 * missed alert is the whole product failing.
 */

const reply = (outputText: string) => async () => ({ outputText })

test('a clear no-change verdict folds into the status line', async () => {
  const d = await classifyWatchDisposition(reply('{"disposition":"status"}'), 'all quiet')
  assert.equal(d, 'status')
})

test('a finding is posted', async () => {
  const d = await classifyWatchDisposition(reply('{"disposition":"post"}'), 'iPad down')
  assert.equal(d, 'post')
})

test('the verdict survives prose around the JSON', async () => {
  const d = await classifyWatchDisposition(
    reply('Sure — here you go:\n{"disposition":"status"}\n'),
    'nothing new',
  )
  assert.equal(d, 'status')
})

test('an unparseable answer posts rather than hides', async () => {
  for (const bad of ['', 'status', 'not json', '{"disposition":"maybe"}']) {
    assert.equal(await classifyWatchDisposition(reply(bad), 'x'), 'post')
  }
})

test('a classifier failure posts rather than hides', async () => {
  const boom = async () => {
    throw new Error('provider down')
  }
  assert.equal(await classifyWatchDisposition(boom, 'x'), 'post')
})

test('rolling is on unless a trigger explicitly opts out', () => {
  assert.equal(isRollingStatusEnabled(null), true)
  assert.equal(isRollingStatusEnabled({}), true)
  assert.equal(isRollingStatusEnabled({ rollingStatus: true }), true)
  assert.equal(isRollingStatusEnabled({ rollingStatus: false }), false)
})

test('status metadata round-trips, and junk reads as absent', () => {
  assert.deepEqual(
    readWatchStatus({
      watchStatus: {
        lastRunAt: '2026-08-12T09:00:00.000Z',
        lastRunId: 'run-1',
        runCount: 54,
        triggerId: 'trig-1',
      },
    }),
    {
      lastRunAt: '2026-08-12T09:00:00.000Z',
      lastRunId: 'run-1',
      runCount: 54,
      triggerId: 'trig-1',
    },
  )
  for (const junk of [null, {}, { watchStatus: {} }, { watchStatus: { runCount: 'x' } }]) {
    assert.equal(readWatchStatus(junk), null)
  }
})
