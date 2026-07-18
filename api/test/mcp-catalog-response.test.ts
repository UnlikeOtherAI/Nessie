import assert from 'node:assert/strict'
import test from 'node:test'

import { isManagedDeepWaterCatalogRecord } from '../src/routes/mcp/catalog-response.js'

const entry = {
  name: 'deep-water',
  organizationId: null,
  visibility: 'public' as const,
}

test('recognizes only the linked first-party global DeepWater catalog', () => {
  assert.equal(
    isManagedDeepWaterCatalogRecord(entry, ['deep-water']),
    true,
  )
  assert.equal(
    isManagedDeepWaterCatalogRecord(
      { ...entry, organizationId: 'org-1', visibility: 'private' },
      ['deep-water'],
    ),
    false,
  )
  assert.equal(
    isManagedDeepWaterCatalogRecord(
      { ...entry, name: 'deep-water-copy' },
      ['deep-water'],
    ),
    false,
  )
  assert.equal(
    isManagedDeepWaterCatalogRecord(entry, []),
    false,
  )
})
