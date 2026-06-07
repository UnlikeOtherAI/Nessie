import assert from 'node:assert/strict'
import test from 'node:test'

import { isWithinPushQuietHours } from '../src/control/push-preferences.js'

test('quiet hours include a same-day window start and exclude its end', () => {
  const quietHours = { start: '09:00', end: '10:00', timezone: 'UTC' }

  assert.equal(isWithinPushQuietHours(quietHours, new Date('2026-06-07T09:00:00.000Z')), true)
  assert.equal(isWithinPushQuietHours(quietHours, new Date('2026-06-07T10:00:00.000Z')), false)
})

test('quiet hours handle windows that cross midnight', () => {
  const quietHours = { start: '22:00', end: '06:00', timezone: 'UTC' }

  assert.equal(isWithinPushQuietHours(quietHours, new Date('2026-06-07T23:30:00.000Z')), true)
  assert.equal(isWithinPushQuietHours(quietHours, new Date('2026-06-08T05:30:00.000Z')), true)
  assert.equal(isWithinPushQuietHours(quietHours, new Date('2026-06-08T12:00:00.000Z')), false)
})

test('quiet hours evaluate now in the user timezone', () => {
  const quietHours = { start: '09:00', end: '10:00', timezone: 'America/New_York' }

  assert.equal(isWithinPushQuietHours(quietHours, new Date('2026-06-07T13:30:00.000Z')), true)
})
