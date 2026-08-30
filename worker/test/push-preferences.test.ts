import assert from 'node:assert/strict'
import test from 'node:test'

import {
  isWithinPushQuietHours,
  shouldSuppressPushForPreferences,
} from '../src/control/push-preferences.js'

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

test('per-event preferences are enabled by default and suppress only their own event', () => {
  const now = new Date('2026-06-07T12:00:00.000Z')
  const pushKinds = [
    'messages',
    'mentions',
    'budgetAlerts',
    'assignedWork',
    'publishedKnowledge',
    'triggerHealth',
  ] as const

  assert.equal(shouldSuppressPushForPreferences({}, now, 'messages'), false)
  for (const kind of pushKinds) {
    assert.equal(shouldSuppressPushForPreferences({ focusModeEnabled: true }, now, kind), true)
  }
  assert.equal(shouldSuppressPushForPreferences({}, now, 'mentions'), false)
  assert.equal(shouldSuppressPushForPreferences({}, now, 'budgetAlerts'), false)
  assert.equal(shouldSuppressPushForPreferences({}, now, 'assignedWork'), false)
  assert.equal(shouldSuppressPushForPreferences({}, now, 'publishedKnowledge'), false)
  assert.equal(shouldSuppressPushForPreferences({ pushMessages: false }, now, 'messages'), true)
  assert.equal(shouldSuppressPushForPreferences({ pushMessages: false }, now, 'mentions'), false)
  assert.equal(shouldSuppressPushForPreferences({ pushMentions: false }, now, 'mentions'), true)
  assert.equal(shouldSuppressPushForPreferences({ pushBudgetAlerts: false }, now, 'budgetAlerts'), true)
  assert.equal(shouldSuppressPushForPreferences({ pushAssignedWork: false }, now, 'assignedWork'), true)
  assert.equal(
    shouldSuppressPushForPreferences({ pushPublishedKnowledge: false }, now, 'publishedKnowledge'),
    true,
  )
})
