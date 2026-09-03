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
