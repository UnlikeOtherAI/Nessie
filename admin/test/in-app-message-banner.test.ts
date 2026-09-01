import assert from 'node:assert/strict'
import test from 'node:test'

import { shouldShowInAppMessageBanner } from '../src/facades/notifications/in-app-message-banner.js'

test('only presents realtime message banners in desktop and browser clients', () => {
  assert.equal(shouldShowInAppMessageBanner(false), true)
  assert.equal(shouldShowInAppMessageBanner(true), false)
})
