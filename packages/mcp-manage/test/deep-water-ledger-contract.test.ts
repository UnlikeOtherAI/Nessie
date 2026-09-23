import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { deepWaterIntegrationPluginManifest } from '../src/integration-plugin-manifests/deep-water.js'
import {
  DEEP_WATER_BRIEF_CONTRACT_VERSION,
  DEEP_WATER_BRIEF_TOOL_NAMES,
  DEEP_WATER_LAUNCHER_TOOL_NAMES,
  deepWaterBriefTools,
} from '../src/integration-plugin-manifests/deep-water-brief-tools.js'
import {
  deepWaterManifestToolNames,
  isCurrentDeepWaterToolContract,
  isLedgerDeepWaterToolContract,
  projectsDeepWaterBriefContract,
} from '../src/deepwater-team-connector.js'

/**
 * The brief tool contract is Nessie's copy of Ledger's, and must stay equal to
 * it: a projected schema that disagrees with Ledger's makes an agent send
 * arguments Ledger refuses, or silently omit ones it needs.
 *
 * `deep-water.ledger-contract.json` is Ledger's own published `tools/list` for
 * the eight tools Nessie projects (Water plan contract §10, fixture 2), copied
 * byte-for-byte from Ledger's `docs/contracts/deepwater-mcp-tools.json`.
 * Replace it from there, never by hand, whenever Ledger's contract changes.
 */

type LedgerTool = {
  name: string
  inputSchema: Record<string, unknown>
  annotations?: Record<string, unknown>
}

const fixture = JSON.parse(readFileSync(
  new URL('../src/integration-plugin-manifests/deep-water.ledger-contract.json', import.meta.url),
  'utf8',
)) as { server: string; endpoint: string; tools: LedgerTool[] }

const names = (tools: ReadonlyArray<{ name: string }>): string[] => tools.map((tool) => tool.name).sort()

test('the fixture is Ledger\'s DeepWater MCP tools/list', () => {
  assert.equal(fixture.server, 'ledger-deepwater')
  assert.equal(fixture.endpoint, '/v1/mcp/deepwater')
})

test('the brief contract is exactly Ledger\'s eight brief-first tools, never research_start', () => {
  assert.equal(DEEP_WATER_BRIEF_CONTRACT_VERSION, '0.3.0')
  assert.deepEqual(names(deepWaterBriefTools), names(fixture.tools))
  assert.equal(deepWaterBriefTools.length, 8)
  assert.equal(DEEP_WATER_BRIEF_TOOL_NAMES.includes('research_start'), false)
})

test('every brief tool input schema deep-equals Ledger\'s tools/list', () => {
  for (const ledgerTool of fixture.tools) {
    const projected = deepWaterBriefTools.find((tool) => tool.name === ledgerTool.name)
    assert.ok(projected, `${ledgerTool.name} is in the brief contract`)
    assert.deepStrictEqual(projected.inputSchema, ledgerTool.inputSchema, ledgerTool.name)
  }
})

test('every brief tool is sensitive: research content and reports cross the boundary', () => {
  for (const tool of deepWaterBriefTools) {
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

test('the manifest projects the brief contract, 0.3.0, with Ledger\'s exact schemas', () => {
  assert.equal(deepWaterIntegrationPluginManifest.version, '0.3.0')
  assert.deepEqual(deepWaterManifestToolNames().sort(), names(fixture.tools))
  assert.equal(deepWaterManifestToolNames().includes('research_start'), false)
  for (const tool of deepWaterIntegrationPluginManifest.mcp.tools) {
    const ledgerTool = fixture.tools.find((candidate) => candidate.name === tool.name)
    assert.deepStrictEqual(tool.inputSchema, ledgerTool?.inputSchema, tool.name)
    // Options are typed fields now; no description carries a prose options contract.
    assert.doesNotMatch(JSON.stringify(tool.inputSchema), /Supported lines/)
  }
})

test('a connector is current only on the manifest\'s exact tool names', () => {
  const brief = DEEP_WATER_BRIEF_TOOL_NAMES.map((name) => ({ name }))
  assert.equal(isCurrentDeepWaterToolContract(brief), true)
  assert.equal(isCurrentDeepWaterToolContract([...brief].reverse()), true)
  assert.equal(isCurrentDeepWaterToolContract(brief.slice(1)), false)
  assert.equal(isCurrentDeepWaterToolContract([...brief, { name: 'research_start' }]), false)
  assert.equal(isCurrentDeepWaterToolContract(DEEP_WATER_LAUNCHER_TOOL_NAMES.map((name) => ({ name }))), false)
  assert.equal(isCurrentDeepWaterToolContract(null), false)
})

test('a brief can be opened only through a connector on the brief contract', () => {
  const brief = fixture.tools.map((tool) => ({ name: tool.name, inputSchema: tool.inputSchema }))
  assert.equal(projectsDeepWaterBriefContract(brief), true)
  assert.equal(projectsDeepWaterBriefContract([...brief, { name: 'research_start' }]), false)
  assert.equal(projectsDeepWaterBriefContract(brief.slice(1)), false)
  assert.equal(projectsDeepWaterBriefContract(DEEP_WATER_LAUNCHER_TOOL_NAMES.map((name) => ({ name }))), false)
})

test('Ledger contracts upgrade in place; the legacy direct-provider contract does not', () => {
  assert.equal(isLedgerDeepWaterToolContract(DEEP_WATER_LAUNCHER_TOOL_NAMES.map((name) => ({ name }))), true)
  assert.equal(isLedgerDeepWaterToolContract(DEEP_WATER_BRIEF_TOOL_NAMES.map((name) => ({ name }))), true)
  assert.equal(isLedgerDeepWaterToolContract([{ name: 'research_create' }]), false)
  assert.equal(isLedgerDeepWaterToolContract([{ name: 'research_status' }, { name: 'research_create' }]), false)
  assert.equal(isLedgerDeepWaterToolContract([]), false)
  assert.equal(isLedgerDeepWaterToolContract(null), false)
})
