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

test('the native phone home header always contrasts with its own surface', () => {
  assert.equal(statusBarStyleForNativePhoneHomeHeader(true, true, 'dark'), 'light')
  assert.equal(statusBarStyleForNativePhoneHomeHeader(true, false, 'light'), 'dark')
  assert.equal(statusBarStyleForNativePhoneHomeHeader(true, false, 'dark'), 'dark')
  assert.equal(statusBarStyleForNativePhoneHomeHeader(false, true, 'dark'), 'dark')
})
