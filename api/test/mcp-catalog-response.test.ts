import assert from 'node:assert/strict'
import test from 'node:test'

import { isManagedIntegrationCatalogRecord } from '@nessie/mcp-manage'
import { redactCatalogAuthConfig } from '../src/routes/mcp/catalog-response.js'

const entry = {
  name: 'deep-water',
  organizationId: null,
  visibility: 'public' as const,
}

test('recognizes only the linked first-party global DeepWater catalog', () => {
  assert.equal(
    isManagedIntegrationCatalogRecord(entry, ['deep-water']),
    true,
  )
  assert.equal(
    isManagedIntegrationCatalogRecord(
      { ...entry, organizationId: 'org-1', visibility: 'private' },
      ['deep-water'],
    ),
    false,
  )
  assert.equal(
    isManagedIntegrationCatalogRecord(
      { ...entry, name: 'deep-water-copy' },
      ['deep-water'],
    ),
    false,
  )
  assert.equal(
    isManagedIntegrationCatalogRecord(entry, []),
    false,
  )
})

test('recognizes only the linked first-party global DeepSignal catalog', () => {
  const deepSignal = {
    name: 'deepsignal',
    organizationId: null,
    visibility: 'public' as const,
  }
  assert.equal(
    isManagedIntegrationCatalogRecord(deepSignal, ['deepsignal']),
    true,
  )
  assert.equal(
    isManagedIntegrationCatalogRecord(
      { ...deepSignal, organizationId: 'org-1', visibility: 'private' },
      ['deepsignal'],
    ),
    false,
  )
  assert.equal(
    isManagedIntegrationCatalogRecord(deepSignal, ['deep-water']),
    false,
  )
})

test('catalog responses never return a static OAuth client secret', () => {
  assert.deepEqual(
    redactCatalogAuthConfig({
      method: 'oauth2',
      clientId: 'client',
      clientSecret: 'must-not-leak',
      scopes: [],
    }),
    {
      method: 'oauth2',
      clientId: 'client',
      scopes: [],
    },
  )
})
