import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
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
 * Replace it from there, never by hand, whenever Ledger's contract changes:
 *
 *   git -C <ledger> show <commit>:docs/contracts/deepwater-mcp-tools.json \
 *     > packages/mcp-manage/src/integration-plugin-manifests/deep-water.ledger-contract.json
 *
 * then set `LEDGER_CONTRACT_SOURCE` to that commit and the file's sha256. The
 * pin is what makes every byte of the copy — descriptions and annotations as
 * well as schemas — Ledger's: an edit here, or a copy from anywhere else,
 * fails until the pin names the Ledger commit it came from.
 */

const LEDGER_CONTRACT_SOURCE = {
  repository: 'UnlikeOtherAI/ledger',
  path: 'docs/contracts/deepwater-mcp-tools.json',
  commit: '7da4b918313cf0009375163cb4d1ae9cd09d4547',
  sha256: 'd44ab7784e83feae70eac24a9fd0fce8fd730ce7dd589087fbebf5157f97b9c3',
} as const

type LedgerTool = {
  name: string
  inputSchema: Record<string, unknown>
  annotations?: Record<string, unknown>
}

const fixtureBytes = readFileSync(
  new URL('../src/integration-plugin-manifests/deep-water.ledger-contract.json', import.meta.url),
)
const fixture = JSON.parse(fixtureBytes.toString('utf8')) as {
  server: string
  endpoint: string
  tools: Array<LedgerTool & { description: string }>
}

const names = (tools: ReadonlyArray<{ name: string }>): string[] => tools.map((tool) => tool.name).sort()

test('the fixture is Ledger\'s DeepWater MCP tools/list', () => {
  assert.equal(fixture.server, 'ledger-deepwater')
  assert.equal(fixture.endpoint, '/v1/mcp/deepwater')
})

test('the fixture is byte-for-byte the pinned Ledger commit\'s, descriptions and annotations included', () => {
  assert.equal(
    createHash('sha256').update(fixtureBytes).digest('hex'),
    LEDGER_CONTRACT_SOURCE.sha256,
    `deep-water.ledger-contract.json differs from ${LEDGER_CONTRACT_SOURCE.repository}@`
      + `${LEDGER_CONTRACT_SOURCE.commit}:${LEDGER_CONTRACT_SOURCE.path}; re-copy it from Ledger and update the pin`,
  )
  for (const tool of fixture.tools) {
    assert.ok(tool.description.length > 0, `${tool.name} has Ledger's description`)
    assert.ok(tool.annotations, `${tool.name} has Ledger's annotations`)
  }
})

test('the manifest\'s descriptions are Nessie\'s own: agents are woken, never told to poll', () => {
  // Ledger's descriptions address a client that reads the planner's reply with
  // research_scope_get; Nessie's agents are woken in their thread instead, so
  // the projected descriptions deliberately differ from the fixture's.
  const description = (name: string) => deepWaterBriefTools.find((tool) => tool.name === name)?.description ?? ''
  for (const name of ['research_scope_start', 'research_scope_reply']) {
    assert.match(description(name), /woken/, name)
    const ledger = fixture.tools.find((tool) => tool.name === name)?.description ?? ''
    assert.match(ledger, /research_scope_get/, `${name}: Ledger tells its clients to read the reply`)
  }
  assert.match(description('research_scope_start'), /do not poll/)
  // A summary is never presented as the full report (N10), in Ledger's words and Nessie's.
  assert.match(description('research_report'), /report_kind=summary means the full report could not be written/)
  assert.match(fixture.tools.find((tool) => tool.name === 'research_report')?.description ?? '', /report_kind/)
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
