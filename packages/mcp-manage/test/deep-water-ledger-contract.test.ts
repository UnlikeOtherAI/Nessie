import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { deepWaterIntegrationPluginManifest } from '../src/integration-plugin-manifests/deep-water.js'
import {
  deepWaterManifestToolNames,
  isCurrentDeepWaterToolContract,
} from '../src/deepwater-team-connector.js'

/**
 * The DeepWater manifest is Nessie's copy of Ledger's tool contract, and must
 * stay equal to it: a projected schema that disagrees with Ledger's makes an
 * agent send arguments Ledger refuses, or silently omit ones it needs.
 *
 * `deep-water.ledger-contract.json` is Ledger's `tools/list` for the eight
 * tools Nessie projects (Water plan contract §10, fixture 2). Ledger publishes
 * it as `docs/contracts/deepwater-mcp-tools.json`; replace this copy
 * byte-for-byte from there whenever Ledger's contract changes.
 */

type LedgerTool = {
  name: string
  inputSchema: Record<string, unknown>
  annotations?: Record<string, unknown>
}

const fixture = JSON.parse(readFileSync(
  new URL('../src/integration-plugin-manifests/deep-water.ledger-contract.json', import.meta.url),
  'utf8',
)) as { tools: LedgerTool[] }

const manifestTools = deepWaterIntegrationPluginManifest.mcp.tools

test('the manifest projects exactly the eight brief-first tools, never research_start', () => {
  assert.equal(deepWaterIntegrationPluginManifest.version, '0.3.0')
  assert.deepEqual(
    [...manifestTools.map((tool) => tool.name)].sort(),
    [...fixture.tools.map((tool) => tool.name)].sort(),
  )
  assert.equal(manifestTools.length, 8)
  assert.equal(manifestTools.some((tool) => tool.name === 'research_start'), false)
  assert.deepEqual(deepWaterManifestToolNames(), manifestTools.map((tool) => tool.name))
})

test('every projected input schema deep-equals Ledger\'s tools/list', () => {
  for (const ledgerTool of fixture.tools) {
    const projected = manifestTools.find((tool) => tool.name === ledgerTool.name)
    assert.ok(projected, `${ledgerTool.name} is projected`)
    assert.deepStrictEqual(projected.inputSchema, ledgerTool.inputSchema, ledgerTool.name)
  }
})

test('every DeepWater tool is sensitive: research content and reports cross the boundary', () => {
  for (const tool of manifestTools) {
    assert.equal(tool.privacyTier, 'sensitive', tool.name)
  }
})

test('only the read tools are declared read-only by Ledger', () => {
  const readOnly = fixture.tools
    .filter((tool) => tool.annotations?.readOnlyHint === true)
    .map((tool) => tool.name)
    .sort()
  assert.deepEqual(readOnly, ['research_list', 'research_report', 'research_scope_get', 'research_status'])
})

test('a team connector is current only on the manifest\'s exact tool names', () => {
  const discovered = fixture.tools.map((tool) => ({ name: tool.name, inputSchema: tool.inputSchema }))
  assert.equal(isCurrentDeepWaterToolContract(discovered), true)
  assert.equal(isCurrentDeepWaterToolContract([...discovered].reverse()), true)
  assert.equal(isCurrentDeepWaterToolContract([...discovered, { name: 'research_start' }]), false)
  assert.equal(isCurrentDeepWaterToolContract(discovered.slice(1)), false)
  const legacy = ['research_start', 'research_status', 'research_report', 'research_list', 'research_cancel']
  assert.equal(isCurrentDeepWaterToolContract(legacy.map((name) => ({ name }))), false)
  assert.equal(isCurrentDeepWaterToolContract(null), false)
})
