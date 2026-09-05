import assert from 'node:assert/strict'
import test from 'node:test'

import { resolveThemeChoice, type ThemeResolutionInput } from '../src/providers/theme-resolution.js'

const resolve = (over: Partial<ThemeResolutionInput> = {}) =>
  resolveThemeChoice({
    localChoice: null,
    organizationHasTheme: false,
    serverChoice: undefined,
    signedIn: true,
    systemDark: false,
    ...over,
  })

test('a person who never chose gets the organisation palette, else Sandstone', () => {
  assert.deepEqual(resolve({ organizationHasTheme: true }), {
    applied: 'organization',
    choice: 'organization',
  })
  assert.deepEqual(resolve(), { applied: 'sandstone', choice: 'sandstone' })
})

test('an explicit choice always beats the organisation palette', () => {
  // This is the whole promise of "a default, never a mandate": there is no
  // lock, so a built-in the person picked wins over the brand every time.
  assert.deepEqual(
    resolve({ organizationHasTheme: true, serverChoice: 'contrast' }),
    { applied: 'contrast', choice: 'contrast' },
  )
  assert.deepEqual(
    resolve({ localChoice: 'forest', organizationHasTheme: true }),
    { applied: 'forest', choice: 'forest' },
  )
  // The account beats the browser: the same person's pick follows them.
  assert.equal(resolve({ localChoice: 'forest', serverChoice: 'ocean' }).applied, 'ocean')
})

test('choosing the organisation theme is a choice like any other', () => {
  assert.deepEqual(
    resolve({ organizationHasTheme: true, serverChoice: 'organization' }),
    { applied: 'organization', choice: 'organization' },
  )
  // Removed, or in an organisation that has none: the stored choice is kept,
  // not rewritten, so a palette that returns comes back to them.
  assert.deepEqual(
    resolve({ organizationHasTheme: false, serverChoice: 'organization' }),
    { applied: 'sandstone', choice: 'organization' },
  )
})

test('System stays the OS pair, and never substitutes the brand palette', () => {
  assert.deepEqual(
    resolve({ organizationHasTheme: true, serverChoice: 'system', systemDark: true }),
    { applied: 'nebula', choice: 'system' },
  )
  assert.deepEqual(
    resolve({ organizationHasTheme: true, serverChoice: 'system', systemDark: false }),
    { applied: 'daylight', choice: 'system' },
  )
})

test('signed out, only the browser has an answer', () => {
  // A server choice from a session that has ended must not outlive it, and
  // there is no organisation to ask — the sign-in screen is instance state.
  assert.deepEqual(
    resolve({ serverChoice: 'ocean', signedIn: false }),
    { applied: 'sandstone', choice: 'sandstone' },
  )
  assert.deepEqual(
    resolve({ localChoice: 'forest', signedIn: false }),
    { applied: 'forest', choice: 'forest' },
  )
  assert.deepEqual(
    resolve({ localChoice: 'organization', organizationHasTheme: false, signedIn: false }),
    { applied: 'sandstone', choice: 'organization' },
  )
})
