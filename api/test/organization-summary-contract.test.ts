import assert from 'node:assert/strict'
import test from 'node:test'

import { OrganizationSummarySchema } from '@nessie/schemas'

const base = {
  id: '00000000-0000-4000-8000-000000000001',
  name: 'Acme Ltd',
  role: 'owner',
  logoAttachmentId: null,
  stripImageMetadata: true,
  conversationalSetupEnabled: false,
  administration: { status: 'allowed' },
  theme: null,
}

/**
 * `nameManagedExternally` is REQUIRED, and this test exists because of how that
 * class of change has broken production here before: a required field added to
 * a wire schema compiles fine at every hand-built object literal that meets
 * `.parse` at runtime, so the first sign of a missed construction site is a 500
 * on a live endpoint. Three sites build this record; if a fourth appears
 * without the field, this fails instead of production.
 */
test('an organisation summary must say whether its name is the IdP’s', () => {
  assert.throws(
    () => OrganizationSummarySchema.parse(base),
    'a summary built without nameManagedExternally must be rejected, not defaulted',
  )
})

test('an organisation summary must name the live administration state', () => {
  const { administration: _administration, ...withoutAdministration } = base
  assert.throws(
    () => OrganizationSummarySchema.parse(withoutAdministration),
    'a summary without administration state must be rejected, not defaulted',
  )
})

test('an SSO-bound organisation is marked, a local one is not', () => {
  assert.equal(
    OrganizationSummarySchema.parse({ ...base, nameManagedExternally: true }).nameManagedExternally,
    true,
  )
  assert.equal(
    OrganizationSummarySchema.parse({ ...base, nameManagedExternally: false }).nameManagedExternally,
    false,
  )
})

/**
 * Same class of failure as `nameManagedExternally` above, one field along: the
 * palette is REQUIRED on the wire because every member's shell renders from it,
 * and a construction site that forgets it would 500 the one endpoint every
 * signed-in screen calls.
 */
test('an organisation summary must carry its palette, even when there is none', () => {
  const { theme: _theme, ...withoutTheme } = base
  assert.throws(
    () => OrganizationSummarySchema.parse({ ...withoutTheme, nameManagedExternally: false }),
    'a summary built without theme must be rejected, not defaulted',
  )
})

test('a palette on the wire is seeds only — colours, never derived tokens', () => {
  const theme = {
    appearance: 'dark' as const,
    accent: '#0f766e',
    surface: '#0b1416',
    sidebar: null,
  }
  assert.deepEqual(
    OrganizationSummarySchema.parse({ ...base, nameManagedExternally: false, theme }).theme,
    theme,
  )
  // `.strict()` is what keeps type, radii and spacing off this contract.
  assert.throws(() =>
    OrganizationSummarySchema.parse({
      ...base,
      nameManagedExternally: false,
      theme: { ...theme, fontFamily: 'Comic Sans' },
    }))
})
