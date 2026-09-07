import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  normalizePersonalBrowserOrigins,
  personalBrowserGrantAllowsOrigin,
} from '../src/personal-access-grant.js'

test('normalizes only distinct exact HTTPS origins for a personal grant', () => {
  assert.deepEqual(normalizePersonalBrowserOrigins([
    'https://accounts.example.test',
    'https://app.example.test',
  ]), ['https://accounts.example.test', 'https://app.example.test'])

  for (const origins of [
    ['http://app.example.test'],
    ['https://app.example.test/path'],
    ['https://app.example.test', 'https://app.example.test'],
  ]) {
    assert.throws(() => normalizePersonalBrowserOrigins(origins))
  }
})

test('an approved origin permits paths but never a sibling origin', () => {
  const origins = ['https://app.example.test']

  assert.equal(personalBrowserGrantAllowsOrigin(origins, 'https://app.example.test/settings'), true)
  assert.equal(personalBrowserGrantAllowsOrigin(origins, 'https://evil.example.test'), false)
  assert.equal(personalBrowserGrantAllowsOrigin(origins, 'not a URL'), false)
})
