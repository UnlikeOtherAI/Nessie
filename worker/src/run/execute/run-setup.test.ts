import assert from 'node:assert/strict'
import test from 'node:test'

import type { ToolSchemaDescriptor } from '@nessie/runtime'

import {
  applyConversationalSetupExclusions,
  applyHandoffToolExclusions,
  applyTodoToolExclusions,
} from './run-setup.js'

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
  stubbedIds: new Set(['mcp_research_start']),
  toolSpecEnabled: true,
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
  assert.deepEqual([...toolset.stubbedIds], ['mcp_research_start'])
  assert.equal(toolset.toolSpecEnabled, true)
})

test('a to-do-disabled agent is not offered either execution builtin', () => {
  const toolset = applyTodoToolExclusions({
    allowedIds: new Set(['todo_start', 'todo_step_update', 'web_search']),
    descriptors: [
      descriptor('todo_start'),
      descriptor('todo_step_update'),
      descriptor('web_search'),
    ],
    stubbedIds: new Set(['todo_start']),
    toolSpecEnabled: true,
  }, false)

  assert.deepEqual([...toolset.allowedIds], ['web_search'])
  assert.deepEqual(toolset.descriptors.map((tool) => tool.toolName), ['web_search'])
  assert.deepEqual([...toolset.stubbedIds], [])
})

test('disabled conversational setup withholds app search and connection request', () => {
  const toolIds = new Set(['app_search', 'app_connect_request', 'web_search'])
  assert.deepEqual(
    [...applyConversationalSetupExclusions(toolIds, false)],
    ['web_search'],
  )
  assert.deepEqual(
    [...applyConversationalSetupExclusions(toolIds, true)],
    ['app_search', 'app_connect_request', 'web_search'],
  )
})
