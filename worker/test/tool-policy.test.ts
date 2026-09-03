import assert from 'node:assert/strict'
import test from 'node:test'
import {
  BUILTIN_TOOL_DEFINITIONS,
  BUILTIN_TOOL_IDS,
  CALL_START_TOOL_ID,
  MEETING_LINK_CREATE_TOOL_ID,
  type BuiltinToolDefinition,
} from '@nessie/runtime'
import {
  authorizeToolCall,
  PA_PRESENCE_PRIVATE_READ_TOOL_IDS,
  resolveAgentTools,
} from '../src/run/tool-policy.js'

const definitions = [
  {
    description: 'Search the web.',
    id: 'web_search',
    summary: 'Search the web.',
    label: 'Web search',
    parameters: { properties: {}, type: 'object' },
    safe: true,
  },
  {
    description: 'Spawn a delegated agent.',
    id: 'spawn_subtask',
    summary: 'Spawn a delegated agent.',
    label: 'Spawn subtask',
    parameters: { properties: {}, type: 'object' },
    safe: false,
  },
  {
    description: 'Send a message as the current user.',
    id: 'send_message',
    summary: 'Send a message as the current user.',
    label: 'Send message',
    parameters: { properties: {}, type: 'object' },
    personalAssistantOnly: true,
    safe: false,
  },
] satisfies BuiltinToolDefinition[]

test('resolveAgentTools does not let agent policy allow ungranted tools', () => {
  const resolved = resolveAgentTools(
    new Set(['web_search']),
    definitions,
    { spawn_subtask: true },
    null,
    'shared',
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
    'shared',
  )

  assert.deepEqual([...resolved.allowedIds], ['spawn_subtask'])
})

test('resolveAgentTools withholds personal-assistant-only tools from a shared agent', () => {
  const resolved = resolveAgentTools(
    new Set(['web_search', 'send_message']),
    definitions,
    null,
    null,
    'shared',
  )

  // The shared agent keeps ordinary tools but never sees the act-as-user tool.
  assert.deepEqual([...resolved.allowedIds].sort(), ['web_search'])
  assert.ok(!resolved.descriptors.some((d) => d.toolName === 'send_message'))
})

test('resolveAgentTools grants personal-assistant-only tools to the personal assistant', () => {
  const resolved = resolveAgentTools(
    new Set(['web_search', 'send_message']),
    definitions,
    null,
    null,
    'personal_assistant',
  )

  assert.deepEqual([...resolved.allowedIds].sort(), ['send_message', 'web_search'])
})

test('a PA presence withholds owner-scoped reads and communication mutations', () => {
  const presenceDefinitions = [
    ...definitions,
    ...['team_search', 'kb_search', 'message_edit', 'message_delete', 'react'].map((id) => ({
      description: id,
      id,
      label: id,
      parameters: { properties: {}, type: 'object' as const },
      safe: false,
    })),
  ] satisfies BuiltinToolDefinition[]
  const resolved = resolveAgentTools(
    new Set(presenceDefinitions.map((tool) => tool.id)),
    presenceDefinitions,
    null,
    null,
    'personal_assistant',
    { isPersonalAssistantPresence: true },
  )

  for (const withheld of [
    'send_message',
    'team_search',
    'kb_search',
    'message_edit',
    'message_delete',
    'react',
  ]) {
    assert.equal(resolved.allowedIds.has(withheld), false, `${withheld} must be withheld`)
  }
  assert.equal(resolved.allowedIds.has('web_search'), true)
})

test('authorizeToolCall reports structured denial reasons', () => {
  assert.deepEqual(
    authorizeToolCall('web_search', new Set(['web_search']), definitions, { web_search: false }, null, 'shared'),
    { allowed: false, reason: 'agent_policy_denied' },
  )
  assert.deepEqual(
    authorizeToolCall('spawn_subtask', new Set(['spawn_subtask']), definitions, null, 'parent-1', 'shared'),
    { allowed: false, reason: 'parent_agent_subtask_denied' },
  )
  assert.deepEqual(
    authorizeToolCall('web_search', new Set(), definitions, null, null, 'shared'),
    { allowed: false, reason: 'tool_not_granted' },
  )
  assert.deepEqual(
    authorizeToolCall('missing_tool', new Set(['missing_tool']), definitions, null, null, 'shared'),
    { allowed: false, reason: 'unknown_tool' },
  )
})

test('authorizeToolCall denies act-as-user tools to a shared agent but allows the personal assistant', () => {
  assert.deepEqual(
    authorizeToolCall('send_message', new Set(['send_message']), definitions, null, null, 'shared'),
    { allowed: false, reason: 'personal_assistant_only' },
  )
  assert.deepEqual(
    authorizeToolCall('send_message', new Set(['send_message']), definitions, null, null, 'personal_assistant'),
    { allowed: true },
  )
})

test('every PA_PRESENCE_PRIVATE_READ_TOOL_IDS entry names a real builtin tool', () => {
  for (const toolId of PA_PRESENCE_PRIVATE_READ_TOOL_IDS) {
    assert.ok(
      BUILTIN_TOOL_IDS.has(toolId),
      `${toolId} in PA_PRESENCE_PRIVATE_READ_TOOL_IDS does not match any BUILTIN_TOOL_IDS entry`,
    )
  }
})

test('meeting link and call start tools are PA-only without an explicit grant', () => {
  const callToolIds = [CALL_START_TOOL_ID, MEETING_LINK_CREATE_TOOL_ID]
  const callTools = BUILTIN_TOOL_DEFINITIONS.filter((tool) => callToolIds.includes(tool.id))
  const shared = resolveAgentTools(
    new Set(callToolIds),
    BUILTIN_TOOL_DEFINITIONS,
    null,
    null,
    'shared',
  )

  assert.deepEqual(callTools.map((tool) => tool.id).sort(), callToolIds.sort())
  for (const tool of callTools) {
    assert.equal(tool.personalAssistantOnly, true)
    assert.notEqual(tool.requiresExplicitGrant, true)
    assert.deepEqual(
      authorizeToolCall(tool.id, new Set([tool.id]), BUILTIN_TOOL_DEFINITIONS, null, null, 'shared'),
      { allowed: false, reason: 'personal_assistant_only' },
    )
    assert.ok(!shared.descriptors.some((descriptor) => descriptor.toolName === tool.id))
  }
})
