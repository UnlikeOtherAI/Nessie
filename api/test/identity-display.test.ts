import assert from 'node:assert/strict'
import test from 'node:test'

import {
  humanizeEmailLocalPart,
  isEmailLikeDisplayName,
  resolveIdentityDisplayName,
  resolveStoredDisplayName,
} from '../src/services/identity-display.js'

test('humanizeEmailLocalPart derives a readable name from an email address', () => {
  assert.equal(humanizeEmailLocalPart('ada.lovelace@example.com'), 'Ada Lovelace')
})

test('resolveIdentityDisplayName prefers a provider name', () => {
  assert.equal(
    resolveIdentityDisplayName('ada@example.com', ['Ada Lovelace']),
    'Ada Lovelace',
  )
})

test('resolveIdentityDisplayName replaces raw email candidates with a readable fallback', () => {
  assert.equal(
    resolveIdentityDisplayName('ada.lovelace@example.com', ['ada.lovelace@example.com']),
    'Ada Lovelace',
  )
})

test('resolveIdentityDisplayName skips alternate email-shaped candidates', () => {
  assert.equal(
    resolveIdentityDisplayName('ada.lovelace@example.com', ['ada@users.example.com']),
    'Ada Lovelace',
  )
})

test('isEmailLikeDisplayName detects display names that should not be shown in chat', () => {
  assert.equal(isEmailLikeDisplayName('ada@example.com'), true)
  assert.equal(isEmailLikeDisplayName('Ada Lovelace'), false)
})

test('resolveStoredDisplayName repairs legacy email-shaped rows', () => {
  assert.equal(
    resolveStoredDisplayName('ada.lovelace@example.com', 'ada.lovelace@example.com'),
    'Ada Lovelace',
  )
  assert.equal(
    resolveStoredDisplayName('ada.lovelace@example.com', 'Ada L.'),
    'Ada L.',
  )
})
