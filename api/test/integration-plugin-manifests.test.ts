import assert from 'node:assert/strict'
import test from 'node:test'

import {
  getIntegrationPluginManifest,
  integrationPluginManifests,
} from '../src/services/integration-plugin-manifests.js'

test('first-party integration manifests cover the sibling products', () => {
  assert.deepEqual(
    integrationPluginManifests.map((manifest) => manifest.productSlug).sort(),
    ['buildme', 'deep-water', 'deeptest'],
  )

  const deepWater = getIntegrationPluginManifest('deep-water')
  assert.equal(deepWater?.mcp.catalogTemplate?.authMethod, 'oauth2')
  assert.equal(deepWater?.install.some((entry) => entry.requiredForAgentUse), true)

  const deepTest = getIntegrationPluginManifest('deeptest')
  assert.equal(deepTest?.mcp.tools[0]?.privacyTier, 'local_only')
  assert.equal(deepTest?.mcp.tools.some((tool) => tool.name === 'deeptest_review'), true)
  assert.equal(deepTest?.mcp.tools.every((tool) => tool.status === 'available'), true)
  assert.equal(
    deepTest?.ui.controls.some(
      (control) => control.id === 'share-safe-import' && control.status === 'available',
    ),
    true,
  )
  assert.equal(deepTest?.privacy.prohibitedByDefault.includes('source code'), true)

  const buildMe = getIntegrationPluginManifest('buildme')
  assert.equal(buildMe?.mcp.catalogTemplate, null)
  assert.equal(buildMe?.mcp.tools.every((tool) => tool.status === 'blocked'), true)
  assert.equal(
    buildMe?.ui.pages.some(
      (page) => page.id === 'link-handoff' && page.status === 'available',
    ),
    true,
  )
  assert.equal(
    buildMe?.ui.controls.some(
      (control) => control.id === 'handoff-intent' && control.status === 'available',
    ),
    true,
  )
})
