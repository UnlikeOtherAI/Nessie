import assert from 'node:assert/strict'
import test from 'node:test'

import { DEEP_WATER_BRIEF_TOOL_NAMES, deepWaterManifestToolNames } from '@nessie/mcp-manage'

import { MANAGED_DEEP_WATER_TOOL_NAMES, createMcpToolNameAllocator } from './mcp-tool-names.js'

/**
 * The DeepWater tool names Nessie manages (Water plan amendments N9.3): the
 * manifest's projected tools plus `research_start`, which stays managed until
 * the launcher handoff retires (phase E). A managed name owns its exposed
 * `mcp_<name>`: a same-named tool from any other server is the one suffixed,
 * so a change to the derivation would silently change which tool an agent
 * calls by that name.
 */

const sorted = (names: Iterable<string>): string[] => [...names].sort()

test('the managed names are the manifest\'s eight brief tools plus research_start', () => {
  assert.deepEqual(sorted(MANAGED_DEEP_WATER_TOOL_NAMES), sorted([...deepWaterManifestToolNames(), 'research_start']))
  assert.deepEqual(sorted(MANAGED_DEEP_WATER_TOOL_NAMES), sorted([
    'research_scope_start',
    'research_scope_reply',
    'research_scope_get',
    'research_scope_launch',
    'research_status',
    'research_report',
    'research_cancel',
    'research_list',
    'research_start',
  ]))
  assert.equal(MANAGED_DEEP_WATER_TOOL_NAMES.size, 9)
  assert.deepEqual(sorted(deepWaterManifestToolNames()), sorted(DEEP_WATER_BRIEF_TOOL_NAMES))
})

test('every managed name is reserved: another server\'s namesake is suffixed, even alone', () => {
  for (const name of MANAGED_DEEP_WATER_TOOL_NAMES) {
    // The toolset allocates managed DeepWater rows first (mcp-toolset.ts).
    const allocate = createMcpToolNameAllocator(MANAGED_DEEP_WATER_TOOL_NAMES)
    assert.equal(allocate(name, true), `mcp_${name}`, name)
    assert.equal(allocate(name, false), `mcp_${name}_2`, name)
    // While DeepWater is in the toolset, a managed name stays its own even when
    // that one tool is not granted to the agent (mcp-toolset.ts).
    const alone = createMcpToolNameAllocator(MANAGED_DEEP_WATER_TOOL_NAMES)
    assert.equal(alone(name, false), `mcp_${name}_2`, `${name} stays reserved for DeepWater`)
  }
  const allocate = createMcpToolNameAllocator(MANAGED_DEEP_WATER_TOOL_NAMES)
  assert.equal(allocate('research_notes', false), 'mcp_research_notes', 'an unmanaged name is untouched')
})
