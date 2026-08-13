import assert from 'node:assert/strict'
import test from 'node:test'

import {
  statusBarStyleForNativePhoneHomeHeader,
  statusBarStyleForScheme,
} from './status-bar'

test('uses dark status indicators for light themes and light indicators for dark themes', () => {
  assert.equal(statusBarStyleForScheme('light'), 'dark')
  assert.equal(statusBarStyleForScheme('dark'), 'light')
})

test('keeps the existing status indicator style for an unavailable color scheme', () => {
  assert.equal(statusBarStyleForScheme(undefined), null)
  assert.equal(statusBarStyleForScheme('unsupported'), null)
})

test('the dark native phone home header uses light status indicators', () => {
  assert.equal(statusBarStyleForNativePhoneHomeHeader(true, 'dark'), 'light')
  assert.equal(statusBarStyleForNativePhoneHomeHeader(true, 'light'), 'light')
  assert.equal(statusBarStyleForNativePhoneHomeHeader(false, 'dark'), 'dark')
})
