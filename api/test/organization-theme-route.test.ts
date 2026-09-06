import assert from 'node:assert/strict'
import test from 'node:test'

import { evaluateOrganizationTheme, UpdateOrganizationRequestSchema } from '@nessie/schemas'

/**
 * What `PATCH /api/organizations/current` accepts for a palette, and what it
 * refuses.
 *
 * The screen already disables Save on a blocking check, but a palette whose
 * text cannot be read must not exist in the database whatever sent it — so the
 * route re-runs the same evaluation, and these are the decisions it makes.
 */

test('a theme-only PATCH is a complete request', () => {
  // The `refine` guarding "send at least one field" had to learn about theme,
  // or saving colours without also renaming the organisation would 400.
  const parsed = UpdateOrganizationRequestSchema.safeParse({
    theme: { appearance: 'dark', accent: '#0f766e', surface: '#0b1416', sidebar: null },
  })
  assert.equal(parsed.success, true)
})

test('null clears the palette, and an absent field leaves it alone', () => {
  assert.equal(UpdateOrganizationRequestSchema.safeParse({ theme: null }).success, true)
  const nameOnly = UpdateOrganizationRequestSchema.parse({ name: 'Acme' })
  assert.equal('theme' in nameOnly, false)
})

test('a palette carrying anything but colours is refused at the wire', () => {
  assert.equal(
    UpdateOrganizationRequestSchema.safeParse({
      theme: {
        appearance: 'dark',
        accent: '#0f766e',
        surface: '#0b1416',
        sidebar: null,
        fontFamily: 'Comic Sans',
      },
    }).success,
    false,
  )
})

test('the route refuses a palette that fails a contrast floor', () => {
  // The check the route runs, on the seed that motivated it: a grey accent on
  // a near-black background is 1.3:1 and cannot be seen.
  const evaluated = evaluateOrganizationTheme({
    appearance: 'dark',
    accent: '#1f2937',
    surface: '#0b1416',
    sidebar: null,
  })
  const blocking = evaluated.checks.find((check) => check.level === 'blocking')
  assert.equal(evaluated.valid, false)
  assert.equal(blocking?.id, 'accent-on-main')
  // The refusal message is the one the screen shows, so both say the same thing.
  assert.match(blocking?.message ?? '', /needs 3:1/)
})

test('a valid palette passes the same gate', () => {
  const evaluated = evaluateOrganizationTheme({
    appearance: 'dark',
    accent: '#0f766e',
    surface: '#0b1416',
    sidebar: null,
  })
  assert.equal(evaluated.valid, true)
  assert.equal(evaluated.checks.some((check) => check.level === 'blocking'), false)
})
