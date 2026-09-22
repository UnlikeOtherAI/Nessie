import assert from 'node:assert/strict'
import test from 'node:test'

import type { ToolSchemaDescriptor } from '@nessie/runtime'

import {
  applyHandoffToolExclusions,
  applyTodoToolExclusions,
  holdsProjectWriteTools,
  resolveProjectDelegatedToolIds,
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

// F16: memory recall narrows on whether the run was offered a lent project
// tool that writes — not on what the policy says, nor on a read-only loan.
test('only a lent, offered, non-safe project tool counts as a project write', () => {
  const readOnly = resolveProjectDelegatedToolIds(true, { ticket_list: true, ticket_read: true })
  assert.equal(holdsProjectWriteTools(readOnly, new Set(readOnly)), false)

  const writes = resolveProjectDelegatedToolIds(true, { ticket_create: true, ticket_list: true })
  assert.equal(holdsProjectWriteTools(writes, new Set(writes)), true)
  // Lent but withheld from the offered toolset (a registry that disallows it).
  assert.equal(holdsProjectWriteTools(writes, new Set(['ticket_list'])), false)
  // Offered by another route (the Personal Assistant) but never lent.
  assert.equal(holdsProjectWriteTools(new Set(), new Set(['ticket_create'])), false)
  // No project delegation at all: nothing is lent whatever the policy grants.
  const none = resolveProjectDelegatedToolIds(false, { ticket_create: true })
  assert.equal(holdsProjectWriteTools(none, new Set(['ticket_create'])), false)
})
