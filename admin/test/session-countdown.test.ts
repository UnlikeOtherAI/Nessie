import assert from 'node:assert/strict'
import test from 'node:test'

import {
  BROWSER_COUNTDOWN_MS,
  browserCountdown,
  formatCountdown,
} from '../src/components/features/browser-cloud/session-countdown'

const AT = (ms: number): string => new Date(ms).toISOString()
const NOW = 1_700_000_000_000

test('nothing to count down without an expiry', () => {
  assert.equal(browserCountdown(null, NOW), null)
  assert.equal(browserCountdown(undefined, NOW), null)
  // A malformed value must not render "NaN:aN" over the browser.
  assert.equal(browserCountdown('not a date', NOW), null)
})

test('most of the idle window is quiet', () => {
  const four = browserCountdown(AT(NOW + 4 * 60_000), NOW)
  assert.equal(four?.warning, false, 'four minutes out is ordinary working time')
  assert.equal(four?.expired, false)
})

test('the last minute warns, and the boundary counts as warning', () => {
  const edge = browserCountdown(AT(NOW + BROWSER_COUNTDOWN_MS), NOW)
  assert.equal(edge?.warning, true)
  assert.equal(edge?.secondsLeft, 60)

  const inside = browserCountdown(AT(NOW + 7_000), NOW)
  assert.equal(inside?.warning, true)
  assert.equal(inside?.secondsLeft, 7)
  assert.equal(inside?.expired, false)
})

/**
 * The reaper is what actually ends the session; this only has to stop claiming
 * time is left. A clock skewed the wrong way would otherwise show a growing
 * negative countdown over a browser that had already gone.
 */
test('past the expiry it reads as closed, never as negative time', () => {
  const gone = browserCountdown(AT(NOW - 30_000), NOW)
  assert.equal(gone?.expired, true)
  assert.equal(gone?.warning, true)
  assert.equal(gone?.secondsLeft, 0)
})

/**
 * The clock here is the reader's; the expiry is the server's; and the reaper
 * is the only thing that actually ends a session. So `expired` must not be
 * read as "stop offering Continue" — a client running a minute fast would then
 * never show the rescue at all, and every reader loses it at the moment it
 * matters most. `warning` stays true past zero for exactly that reason.
 */
test('the warning does not switch off at zero', () => {
  const past = browserCountdown(AT(NOW - 5_000), NOW)
  assert.equal(past?.warning, true, 'Continue must still be offered')
  assert.equal(past?.expired, true, 'while the copy says it is closing')
})

test('it reads as a clock', () => {
  assert.equal(formatCountdown(60), '1:00')
  assert.equal(formatCountdown(7), '0:07')
  assert.equal(formatCountdown(0), '0:00')
})
