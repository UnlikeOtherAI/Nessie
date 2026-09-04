import assert from 'node:assert/strict'
import test from 'node:test'

import {
  DIRECT_DESKTOP_UPDATE_REMIND_AFTER_MS,
  shouldOfferDirectDesktopUpdate,
} from '../src/lib/direct-desktop-updater.js'

const update = { body: null, currentVersion: '0.1.0', version: '0.1.1' }

test('a skipped version remains skipped, but a later version is offered', () => {
  assert.equal(shouldOfferDirectDesktopUpdate(update, { skippedVersion: '0.1.1' }, 100), false)
  assert.equal(
    shouldOfferDirectDesktopUpdate({ ...update, version: '0.1.2' }, { skippedVersion: '0.1.1' }, 100),
    true,
  )
})

test('a reminder suppresses only the same release until tomorrow', () => {
  const preference = { remindAfter: 100 + DIRECT_DESKTOP_UPDATE_REMIND_AFTER_MS, remindVersion: '0.1.1' }
  assert.equal(shouldOfferDirectDesktopUpdate(update, preference, 100), false)
  assert.equal(shouldOfferDirectDesktopUpdate(update, preference, preference.remindAfter), true)
  assert.equal(shouldOfferDirectDesktopUpdate({ ...update, version: '0.1.2' }, preference, 100), true)
})
