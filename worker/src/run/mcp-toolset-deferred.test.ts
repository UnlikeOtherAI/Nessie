import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildDeferredView,
  buildInlineView,
  MAX_LOADED_TOOLS,
} from './mcp-toolset-deferred.js'
import type { McpToolEntry } from './mcp-toolset.js'
import type { AgenticToolResult } from './tools.js'

/**
 * The deferred presentation keeps large connector fleets out of the model's
 * context: three small meta tools instead of every schema, with load/drop
 * mutating a live descriptor array the loop re-reads each iteration.
 */

const entry = (name: string, connector: string, description: string): McpToolEntry => ({
  registryEntryId: `reg-${name}`,
  originalToolName: name,
  exposedName: `mcp_${name}`,
  description,
  inputSchema: {
    type: 'object',
    properties: { id: { type: 'string' }, body: { type: 'string' } },
    required: ['id'],
  },
  instanceId: 'inst-1',
  connectorLabel: connector,
})

const FLEET: McpToolEntry[] = [
  entry('create_page', 'Notion', 'Create a page in a Notion workspace'),
  entry('search_pages', 'Notion', 'Search Notion pages'),
  entry('list_charges', 'Stripe', 'List Stripe charges'),
  entry('create_customer', 'Stripe', 'Create a Stripe customer'),
  entry('create_issue', 'Linear', 'Create a Linear issue'),
]

const dispatched: string[] = []
const baseDispatch = async (name: string): Promise<AgenticToolResult> => {
  dispatched.push(name)
  return { inputSummary: '', output: 'ok', success: true }
}

test('deferred view starts with only the three meta tools', () => {
  const view = buildDeferredView(FLEET, baseDispatch)
  assert.deepEqual(
    view.descriptors.map((d) => d.toolName),
    ['mcp_find_tools', 'mcp_load_tools', 'mcp_drop_tools'],
  )
  // Every real tool stays dispatchable even though its schema is not loaded.
  assert.ok(view.handledNames.has('mcp_create_page'))
  assert.ok(view.handledNames.has('mcp_find_tools'))
})

test('mcp_find_tools ranks matches and includes a parameter summary', async () => {
  const view = buildDeferredView(FLEET, baseDispatch)
  const result = await view.dispatch('mcp_find_tools', { query: 'create notion page' })
  assert.equal(result.success, true)
  const [firstMatch] = result.output.split('\n').filter((line) => line.startsWith('- '))
  assert.match(firstMatch ?? '', /mcp_create_page/)
  assert.match(result.output, /params: id\*, body/)
  assert.match(result.output, /\[Notion\]/)
})

test('mcp_find_tools explains itself when nothing matches', async () => {
  const view = buildDeferredView(FLEET, baseDispatch)
  const result = await view.dispatch('mcp_find_tools', { query: 'zzzzz' })
  assert.match(result.output, /No connector tools matched/)
  assert.match(result.output, /Notion \(2\)/)
})

test('mcp_load_tools appends live schemas; mcp_drop_tools removes them', async () => {
  const view = buildDeferredView(FLEET, baseDispatch)
  await view.dispatch('mcp_load_tools', { names: ['mcp_create_page', 'mcp_nope'] })
  assert.deepEqual(
    view.descriptors.map((d) => d.toolName).slice(3),
    ['mcp_create_page'],
  )
  const loadResult = await view.dispatch('mcp_load_tools', { names: ['mcp_list_charges'] })
  assert.match(loadResult.output, /Loaded 1 tool/)
  assert.equal(view.descriptors.length, 5)

  await view.dispatch('mcp_drop_tools', {})
  assert.equal(view.descriptors.length, 3)
})

test('loaded schemas are capped with oldest-first eviction', async () => {
  const many = Array.from({ length: MAX_LOADED_TOOLS + 3 }, (_, i) =>
    entry(`tool_${i}`, 'Bulk', `Bulk tool ${i}`),
  )
  const view = buildDeferredView(many, baseDispatch)
  await view.dispatch('mcp_load_tools', {
    names: many.map((e) => e.exposedName),
  })
  assert.equal(view.descriptors.length - 3, MAX_LOADED_TOOLS)
  // Oldest (tool_0..tool_2) evicted, newest retained.
  const loadedNames = view.descriptors.slice(3).map((d) => d.toolName)
  assert.ok(!loadedNames.includes('mcp_tool_0'))
  assert.ok(loadedNames.includes(`mcp_tool_${MAX_LOADED_TOOLS + 2}`))
})

test('real tools dispatch through the base even when not loaded', async () => {
  dispatched.length = 0
  const view = buildDeferredView(FLEET, baseDispatch)
  const result = await view.dispatch('mcp_create_issue', { title: 'x' })
  assert.equal(result.success, true)
  assert.deepEqual(dispatched, ['mcp_create_issue'])
})

test('views are independent — a sub-agent loading tools never mutates the parent', async () => {
  const parent = buildDeferredView(FLEET, baseDispatch)
  const child = buildDeferredView(FLEET, baseDispatch)
  await child.dispatch('mcp_load_tools', { names: ['mcp_create_page'] })
  assert.equal(child.descriptors.length, 4)
  assert.equal(parent.descriptors.length, 3)
})

test('inline view exposes every schema with no meta tools', () => {
  const view = buildInlineView(FLEET, baseDispatch)
  assert.equal(view.descriptors.length, FLEET.length)
  assert.ok(!view.handledNames.has('mcp_find_tools'))
})
