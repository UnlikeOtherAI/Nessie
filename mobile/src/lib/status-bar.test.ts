import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { statusBarStyleForScheme } from './status-bar'

test('uses dark status indicators for light themes and light indicators for dark themes', () => {
  assert.equal(statusBarStyleForScheme('light'), 'dark')
  assert.equal(statusBarStyleForScheme('dark'), 'light')
})

test('keeps the existing status indicator style for an unavailable color scheme', () => {
  assert.equal(statusBarStyleForScheme(undefined), null)
  assert.equal(statusBarStyleForScheme('unsupported'), null)
})

test('the Channels home does not override the active theme status indicators', () => {
  const app = readFileSync(new URL('../../App.tsx', import.meta.url).pathname, 'utf8')

  assert.match(app, /<StatusBar style=\{statusBarStyle\} \/>/)
  assert.doesNotMatch(app, /showNativePhoneConversationMenu \? 'light' : statusBarStyle/)
})
