import assert from 'node:assert/strict'
import test from 'node:test'

import {
  statusBarStyleForNativeBackdrop,
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

test('a native status backdrop always determines the indicator contrast', () => {
  assert.equal(statusBarStyleForNativeBackdrop(true, true, 'dark'), 'light')
  assert.equal(statusBarStyleForNativeBackdrop(true, false, 'light'), 'dark')
  assert.equal(statusBarStyleForNativeBackdrop(true, false, 'dark'), 'dark')
  assert.equal(statusBarStyleForNativeBackdrop(false, true, 'dark'), 'dark')
})
