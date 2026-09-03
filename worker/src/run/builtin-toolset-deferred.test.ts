import assert from 'node:assert/strict'
import test from 'node:test'

import {
  BUILTIN_TOOL_DEFINITIONS,
  type BuiltinToolDefinition,
} from '@nessie/runtime'

import {
  BUILTIN_STUB_INPUT_SCHEMA,
  BUILTIN_HOT_TOOL_IDS,
  BUILTIN_TOOL_SPEC_NAME,
  buildBuiltinToolsetView,
  executeBuiltinToolSpec,
} from './builtin-toolset-deferred.js'
import { resolveAgentTools } from './tool-policy.js'

const definition = (
  id: string,
  required: string[] = ['value'],
): BuiltinToolDefinition => ({
  id,
  category: 'team',
  description: `Full description for ${id}`,
  label: id,
  parameters: {
    type: 'object',
    properties: { value: { type: 'string' } },
    required,
  },
  safe: true,
  summary: `Summary for ${id}`,
})

const definitions = [
  definition('web_search', ['value']),
  definition('send_message', ['value']),
  definition('kb_document_edit', ['value']),
]

test('a resolved set at or below the threshold stays byte-identical to full inline mode', () => {
  const view = buildBuiltinToolsetView(definitions, definitions.length)

  assert.deepEqual(view.descriptors, definitions.map((tool) => ({
    toolName: tool.id,
    description: tool.description,
    inputSchema: tool.parameters,
  })))
  assert.equal(view.toolSpecEnabled, false)
  assert.deepEqual([...view.stubbedIds], [])
})

test('a resolved set above the threshold keeps hot schemas and stubs every other real name', () => {
  const view = buildBuiltinToolsetView(definitions, 2)

  assert.deepEqual(view.descriptors.map((tool) => tool.toolName), [
    'web_search',
    'send_message',
    'kb_document_edit',
    BUILTIN_TOOL_SPEC_NAME,
  ])
  assert.deepEqual(view.descriptors[0], {
    toolName: 'web_search',
    description: definitions[0]?.description,
    inputSchema: definitions[0]?.parameters,
  })
  assert.deepEqual(view.descriptors[1], {
    toolName: 'send_message',
    description: definitions[1]?.summary,
    inputSchema: BUILTIN_STUB_INPUT_SCHEMA,
  })
  assert.deepEqual(view.descriptors[2], {
    toolName: 'kb_document_edit',
    description: definitions[2]?.description,
    inputSchema: definitions[2]?.parameters,
  })
  assert.deepEqual([...view.stubbedIds], ['send_message'])
})

test('the fixed hot set is fully specified and every other builtin uses its curated stub', () => {
  assert.deepEqual([...BUILTIN_HOT_TOOL_IDS], [
    'react',
    'web_search',
    'web_fetch',
    'team_search',
    'message_search',
    'people_search',
    'channel_find',
    'delegate',
    'kb_document_compose',
    'kb_document_edit',
  ])
  const view = buildBuiltinToolsetView(BUILTIN_TOOL_DEFINITIONS, 0)
  const hotIds = new Set<string>(BUILTIN_HOT_TOOL_IDS)

  for (const definition of BUILTIN_TOOL_DEFINITIONS) {
    const descriptor = view.descriptors.find((tool) => tool.toolName === definition.id)
    assert.ok(descriptor)
    if (hotIds.has(definition.id)) {
      assert.equal(descriptor.description, definition.description)
      assert.deepEqual(descriptor.inputSchema, definition.parameters)
    } else {
      assert.equal(descriptor.description, definition.summary)
      assert.deepEqual(descriptor.inputSchema, BUILTIN_STUB_INPUT_SCHEMA)
    }
  }
})

test('tool_spec returns allowed full schemas and corrects unknown names', () => {
  const result = executeBuiltinToolSpec(
    { names: ['send_message', 'not_allowed'] },
    definitions,
  )
  const output = JSON.parse(result.output) as {
    message: string
    tools: Array<Record<string, unknown>>
    unknownNames: string[]
  }

  assert.equal(result.success, true)
  assert.deepEqual(output.tools, [{
    name: 'send_message',
    description: definitions[1]?.description,
    inputSchema: definitions[1]?.parameters,
  }])
  assert.deepEqual(output.unknownNames, ['not_allowed'])
  assert.match(output.message, /exact names from the current tool list/)
})

test('repeated composition produces a byte-stable descriptor array', () => {
  const first = buildBuiltinToolsetView(definitions, 2)
  const second = buildBuiltinToolsetView(definitions, 2)

  assert.equal(JSON.stringify(first.descriptors), JSON.stringify(second.descriptors))
})

// End-to-end authorization pin: the agent loop composes tool_spec's lookup
// list from the run's RESOLVED tool ids, never the raw registry. A shared
// agent must not be able to read a PA-only tool's schema through tool_spec —
// this is what breaks if a refactor ever passes BUILTIN_TOOL_DEFINITIONS
// unfiltered into executeBuiltinToolSpec.
test('tool_spec cannot surface a PA-only schema to a shared agent', () => {
  const enabledIds = new Set(BUILTIN_TOOL_DEFINITIONS.map((tool) => tool.id))
  const resolved = resolveAgentTools(
    enabledIds,
    BUILTIN_TOOL_DEFINITIONS,
    null,
    null,
    'shared',
  )
  // Mirrors agent-loop.ts: allowed definitions are filtered by resolved ids.
  const allowedDefinitions = BUILTIN_TOOL_DEFINITIONS.filter((tool) =>
    resolved.allowedIds.has(tool.id),
  )
  assert.equal(resolved.allowedIds.has('send_message'), false)

  const result = executeBuiltinToolSpec(
    { names: ['send_message', 'team_search'] },
    allowedDefinitions,
  )
  const output = JSON.parse(result.output) as {
    tools: Array<{ name: string }>
    unknownNames?: string[]
  }
  assert.deepEqual(output.tools.map((tool) => tool.name), ['team_search'])
  assert.deepEqual(output.unknownNames, ['send_message'])
})
