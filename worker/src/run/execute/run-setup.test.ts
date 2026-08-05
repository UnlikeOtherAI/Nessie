import assert from 'node:assert/strict'
import test from 'node:test'

import type { ToolSchemaDescriptor } from '@nessie/runtime'

import { applyHandoffToolExclusions } from './run-setup.js'

const descriptor = (toolName: string): ToolSchemaDescriptor => ({
  toolName,
  description: `${toolName} description`,
  inputSchema: { type: 'object', properties: {} },
})

const resolved = () => ({
  allowedIds: new Set(['delegate', 'web_search', 'mcp_research_start']),
  descriptors: [
    descriptor('delegate'),
    descriptor('web_search'),
    descriptor('mcp_research_start'),
  ],
})

test('an ordinary turn keeps delegate in the advertised toolset', () => {
  const toolset = applyHandoffToolExclusions(resolved(), false)

  assert.ok(toolset.allowedIds.has('delegate'))
  assert.ok(toolset.descriptors.some((tool) => tool.toolName === 'delegate'))
})

test('a DeepWater launch turn is never shown delegate', () => {
  const toolset = applyHandoffToolExclusions(resolved(), true)

  assert.ok(!toolset.allowedIds.has('delegate'))
  assert.ok(!toolset.descriptors.some((tool) => tool.toolName === 'delegate'))
  // Everything else the run resolved is untouched.
  assert.deepEqual(
    toolset.descriptors.map((tool) => tool.toolName),
    ['web_search', 'mcp_research_start'],
  )
  assert.deepEqual([...toolset.allowedIds].sort(), ['mcp_research_start', 'web_search'])
})
