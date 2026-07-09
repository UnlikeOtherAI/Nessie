import assert from 'node:assert/strict'
import test from 'node:test'

import {
  getIntegrationPluginManifest,
  integrationPluginManifests,
} from '../src/services/integration-plugin-manifests.js'

test('first-party integration manifests cover the sibling products', () => {
  assert.deepEqual(
    integrationPluginManifests.map((manifest) => manifest.productSlug).sort(),
    ['buildme', 'deep-water', 'deepsignal', 'deeptest'],
  )

  const deepWater = getIntegrationPluginManifest('deep-water')
  assert.equal(deepWater?.mcp.catalogTemplate?.authMethod, 'oauth2')
  assert.equal(deepWater?.install.some((entry) => entry.requiredForAgentUse), true)

  const deepTest = getIntegrationPluginManifest('deeptest')
  assert.equal(deepTest?.mcp.tools[0]?.privacyTier, 'local_only')
  assert.equal(deepTest?.privacy.prohibitedByDefault.includes('source code'), true)

  const buildMe = getIntegrationPluginManifest('buildme')
  assert.equal(buildMe?.mcp.catalogTemplate, null)
  assert.equal(buildMe?.mcp.tools.every((tool) => tool.status === 'blocked'), true)

  const deepSignal = getIntegrationPluginManifest('deepsignal')
  assert.equal(deepSignal?.mcp.catalogTemplate?.authMethod, 'oauth2')
  assert.equal(
    deepSignal?.mcp.catalogTemplate?.transport.url,
    'https://api.deepsignal.live/mcp',
  )
  assert.equal(deepSignal?.install[0]?.mode, 'remote_mcp_oauth')
  assert.equal(deepSignal?.install.some((entry) => entry.requiredForAgentUse), true)
  assert.deepEqual(
    deepSignal?.mcp.tools.map((tool) => tool.name),
    [
      'chat',
      'conversation_list',
      'conversation_history',
      'insight_digest',
      'insight_act',
      'api_research',
    ],
  )
  assert.equal(
    deepSignal?.privacy.prohibitedByDefault.includes('Nessie inference on DeepSignal turns'),
    true,
  )
})
