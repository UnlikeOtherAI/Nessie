import assert from 'node:assert/strict'
import test from 'node:test'

import { resolveIdentityDisplayName } from '../src/services/identity-display.js'

test('resolveIdentityDisplayName prefers a provider name', () => {
  assert.equal(
    resolveIdentityDisplayName('ada@example.com', ['Ada Lovelace']),
    'Ada Lovelace',
  )
})

test('resolveIdentityDisplayName reports no name rather than inventing one', () => {
  // Nessie no longer manufactures "Ada Lovelace" from the address: the profile
  // belongs to the provider, so an absent claim stays absent and the caller
  // leaves the mirror alone (or names a brand-new row by its email address).
  assert.equal(
    resolveIdentityDisplayName('ada.lovelace@example.com', [undefined, '   ']),
    undefined,
  )
})

test('resolveIdentityDisplayName ignores a candidate that just echoes the email', () => {
  assert.equal(
    resolveIdentityDisplayName('ada.lovelace@example.com', ['Ada.Lovelace@Example.com']),
    undefined,
  )
  // A different address is still an assertion about the person, so it is kept.
  assert.equal(
    resolveIdentityDisplayName('ada.lovelace@example.com', ['ada@users.example.com']),
    'ada@users.example.com',
  )
})
