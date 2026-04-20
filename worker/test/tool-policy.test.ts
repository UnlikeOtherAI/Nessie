import assert from 'node:assert/strict'
import test from 'node:test'
import type { BuiltinToolDefinition } from '@nessie/runtime'
import { authorizeToolCall, resolveAgentTools } from '../src/run/tool-policy.js'

const definitions = [
  {
    description: 'Search the web.',
    id: 'web_search',
    label: 'Web search',
    parameters: { properties: {}, type: 'object' },
    safe: true,
  },
  {
    description: 'Spawn a delegated agent.',
    id: 'spawn_subtask',
    label: 'Spawn subtask',
    parameters: { properties: {}, type: 'object' },
    safe: false,
  },
] satisfies BuiltinToolDefinition[]

test('resolveAgentTools does not let agent policy allow ungranted tools', () => {
  const resolved = resolveAgentTools(
    new Set(['web_search']),
    definitions,
    { spawn_subtask: true },
    null,
  )

  assert.deepEqual([...resolved.allowedIds].sort(), ['web_search'])
  assert.deepEqual(
    resolved.descriptors.map((descriptor) => descriptor.toolName),
    ['web_search'],
  )
})

test('resolveAgentTools lets agent policy deny a granted tool', () => {
  const resolved = resolveAgentTools(
    new Set(['spawn_subtask', 'web_search']),
    definitions,
    { web_search: false },
    null,
  )

  assert.deepEqual([...resolved.allowedIds], ['spawn_subtask'])
})

test('authorizeToolCall reports structured denial reasons', () => {
  assert.deepEqual(
    authorizeToolCall('web_search', new Set(['web_search']), definitions, { web_search: false }, null),
    { allowed: false, reason: 'agent_policy_denied' },
  )
  assert.deepEqual(
    authorizeToolCall('spawn_subtask', new Set(['spawn_subtask']), definitions, null, 'parent-1'),
    { allowed: false, reason: 'parent_agent_subtask_denied' },
  )
  assert.deepEqual(
    authorizeToolCall('web_search', new Set(), definitions, null, null),
    { allowed: false, reason: 'tool_not_granted' },
  )
  assert.deepEqual(
    authorizeToolCall('missing_tool', new Set(['missing_tool']), definitions, null, null),
    { allowed: false, reason: 'unknown_tool' },
  )
})
