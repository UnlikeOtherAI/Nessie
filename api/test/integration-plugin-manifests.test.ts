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
  assert.equal(deepWater?.mcp.catalogTemplate?.authMethod, 'bearer')
  assert.equal(
    deepWater?.mcp.catalogTemplate?.transport.urlEnv,
    'LEDGER_DEEPWATER_MCP_URL',
  )
  assert.deepEqual(
    deepWater?.mcp.tools.map((tool) => tool.name),
    [
      'research_start',
      'research_status',
      'research_report',
      'research_list',
      'research_cancel',
    ],
  )
  assert.deepEqual(
    (deepWater?.mcp.tools.find((tool) => tool.name === 'research_start')
      ?.inputSchema as { required?: string[] } | undefined)?.required,
    ['query'],
  )
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

test('deepsignal and deep-water declare surface-registry surfaces', () => {
  const deepSignal = getIntegrationPluginManifest('deepsignal')
  const chat = deepSignal?.surfaces.find((surface) => surface.type === 'chat_assistant')
  assert.ok(chat, 'deepsignal declares a chat_assistant surface')
  assert.equal(chat?.type === 'chat_assistant' ? chat.channelKind : null, 'external_agent')
  assert.equal(chat?.type === 'chat_assistant' ? chat.productSlug : null, 'deepsignal')
  assert.equal(chat?.requires.linked, true)
  assert.equal(chat?.requires.capability, 'external_agent')

  const signals = deepSignal?.surfaces.find((surface) => surface.type === 'nav_page')
  assert.ok(signals, 'deepsignal declares a Signals nav_page')
  assert.equal(signals?.type === 'nav_page' ? signals.route : null, '/signals')
  assert.equal(signals?.requires.linked, true)

  const deepWater = getIntegrationPluginManifest('deep-water')
  const research = deepWater?.surfaces.find((surface) => surface.type === 'documents_section')
  assert.ok(research, 'deep-water declares a Research documents_section')
  assert.equal(research?.type === 'documents_section' ? research.view : null, 'deep-water-research')
  assert.equal(research?.requires.connectorActive, true)

  // Products without declared surfaces stay empty (additive/optional).
  assert.deepEqual(getIntegrationPluginManifest('deeptest')?.surfaces, [])
  assert.deepEqual(getIntegrationPluginManifest('buildme')?.surfaces, [])
})
