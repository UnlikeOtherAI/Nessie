import assert from 'node:assert/strict'
import test from 'node:test'

import {
  BUILTIN_TOOL_DEFINITIONS,
  type BuiltinToolDefinition,
} from '@nessie/runtime'

import {
  BUILTIN_PROMOTED_SCHEMA_BUDGET_CHARS,
  BUILTIN_STUB_INPUT_SCHEMA,
  BUILTIN_HOT_TOOL_IDS,
  BUILTIN_TOOL_SPEC_NAME,
  appendStubbedBuiltinSchema,
  buildBuiltinToolsetView,
  executeToolSpec,
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

const promotedDefinitions = [
  definition('web_search'),
  definition('ticket_list'),
  definition('ticket_create'),
  definition('send_message'),
  definition('kb_list'),
]

const fullIds = (view: ReturnType<typeof buildBuiltinToolsetView>): string[] =>
  view.descriptors
    .filter((tool) => tool.inputSchema !== BUILTIN_STUB_INPUT_SCHEMA && tool.toolName !== BUILTIN_TOOL_SPEC_NAME)
    .map((tool) => tool.toolName)

test('a run\'s own grants arrive in full while every other tool stays a stub', () => {
  const view = buildBuiltinToolsetView(promotedDefinitions, 2, {
    promotedIds: ['ticket_create', 'ticket_list', 'not_allowed'],
  })

  // Definition order, not promotion order: the array stays byte-stable.
  assert.deepEqual(view.descriptors.map((tool) => tool.toolName), [
    'web_search', 'ticket_list', 'ticket_create', 'send_message', 'kb_list', BUILTIN_TOOL_SPEC_NAME,
  ])
  assert.deepEqual(fullIds(view), ['web_search', 'ticket_list', 'ticket_create'])
  assert.deepEqual([...view.stubbedIds].sort(), ['kb_list', 'send_message'])
  // An id the run is not allowed is never conjured into the array.
  assert.equal(view.descriptors.some((tool) => tool.toolName === 'not_allowed'), false)
})

test('promotion stops at its budget, in priority order, and skips what does not fit', () => {
  const size = (id: string): number => {
    const tool = promotedDefinitions.find((candidate) => candidate.id === id)!
    return JSON.stringify({ toolName: tool.id, description: tool.description, inputSchema: tool.parameters }).length
  }
  // Room for exactly two: the first two in priority order win.
  const two = buildBuiltinToolsetView(promotedDefinitions, 2, {
    promotedIds: ['send_message', 'ticket_create', 'ticket_list'],
    promotedSchemaBudgetChars: size('send_message') + size('ticket_create'),
  })
  assert.deepEqual(fullIds(two), ['web_search', 'ticket_create', 'send_message'])
  assert.ok(two.stubbedIds.has('ticket_list'))

  // A tool larger than what is left stays a stub; a smaller one after it fits.
  const large = definition('ticket_update')
  large.description = 'x'.repeat(2_000)
  const withLarge = [...promotedDefinitions, large]
  const skipped = buildBuiltinToolsetView(withLarge, 2, {
    promotedIds: ['ticket_update', 'kb_list'],
    promotedSchemaBudgetChars: size('kb_list'),
  })
  assert.deepEqual(fullIds(skipped), ['web_search', 'kb_list'])
  assert.ok(skipped.stubbedIds.has('ticket_update'))

  const none = buildBuiltinToolsetView(promotedDefinitions, 2, {
    promotedIds: ['ticket_create'],
    promotedSchemaBudgetChars: 0,
  })
  assert.deepEqual(fullIds(none), ['web_search'])
})

test('tool_spec is offered only while something is still a stub', () => {
  const everything = buildBuiltinToolsetView(promotedDefinitions, 2, {
    promotedIds: promotedDefinitions.map((tool) => tool.id),
  })
  assert.equal(everything.toolSpecEnabled, false)
  assert.equal(everything.stubbedIds.size, 0)
  assert.equal(everything.descriptors.some((tool) => tool.toolName === BUILTIN_TOOL_SPEC_NAME), false)
})

test('promoting every builtin adds no more than the budget to the prompt', () => {
  const view = buildBuiltinToolsetView(BUILTIN_TOOL_DEFINITIONS, 0, {
    promotedIds: BUILTIN_TOOL_DEFINITIONS.map((tool) => tool.id),
  })
  const hotIds = new Set<string>(BUILTIN_HOT_TOOL_IDS)
  const promotedChars = view.descriptors
    .filter((tool) => !hotIds.has(tool.toolName) && !view.stubbedIds.has(tool.toolName)
      && tool.toolName !== BUILTIN_TOOL_SPEC_NAME)
    .reduce((total, tool) => total + JSON.stringify(tool).length, 0)
  assert.ok(promotedChars > 0)
  assert.ok(promotedChars <= BUILTIN_PROMOTED_SCHEMA_BUDGET_CHARS, `${promotedChars} chars promoted`)
  assert.ok(view.stubbedIds.size > 0, 'the rest stays deferred')
})

// F15 through the resolver: a board-owning shared agent's lent ticket tools and
// its other explicit grants arrive with schemas, so its first real action is
// not preceded by a tool_spec for each.
test('a shared agent\'s lent project tools and explicit grants are resolved in full', () => {
  const enabledIds = new Set(BUILTIN_TOOL_DEFINITIONS.map((tool) => tool.id))
  const lent = new Set(['ticket_list', 'ticket_create', 'ticket_move'])
  const resolved = resolveAgentTools(
    enabledIds,
    BUILTIN_TOOL_DEFINITIONS,
    {
      ticket_list: true,
      ticket_create: true,
      ticket_move: true,
      // An ordinary builtin named on purpose, and an explicit grant.
      http_fetch: true,
      send_message: true,
      channel_update: true,
    },
    null,
    'shared',
    { inlineToolLimit: 20, projectDelegatedToolIds: lent },
  )
  const full = new Set(
    resolved.descriptors
      .filter((tool) => tool.inputSchema !== BUILTIN_STUB_INPUT_SCHEMA)
      .map((tool) => tool.toolName),
  )
  for (const id of [...lent, 'http_fetch', 'send_message']) {
    assert.ok(full.has(id), `${id} arrives with its schema`)
    assert.equal(resolved.stubbedIds.has(id), false)
  }
  // An ordinary builtin nobody named is still deferred.
  assert.ok(resolved.stubbedIds.has('kb_list'))
  // `true` never widens authorization: a PA-only tool stays out altogether.
  assert.equal(resolved.allowedIds.has('channel_update'), false)
  assert.equal(resolved.descriptors.some((tool) => tool.toolName === 'channel_update'), false)
  // Without the run's lending, a policy `true` on a board tool admits nothing.
  const unlent = resolveAgentTools(
    enabledIds,
    BUILTIN_TOOL_DEFINITIONS,
    { ticket_create: true },
    null,
    'shared',
    { inlineToolLimit: 20 },
  )
  assert.equal(unlent.allowedIds.has('ticket_create'), false)
})

test('tool_spec returns allowed full schemas and corrects unknown names', () => {
  const result = executeToolSpec(
    { names: ['send_message', 'not_allowed'] },
    definitions,
    [],
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

test('a deferred builtin policy failure does not carry an argument schema', () => {
  const toolName = 'send_message'
  const result = appendStubbedBuiltinSchema(
    toolName,
    {
      inputSummary: 'channelId=shared-channel',
      output: 'Tool error: write refused by the disclosure boundary',
      success: false,
    },
    new Set([toolName]),
    definitions,
  )

  assert.doesNotMatch(result.output, /Exact argument schema/)
})

test('a deferred builtin argument failure carries its argument schema', () => {
  const toolName = 'send_message'
  const result = appendStubbedBuiltinSchema(
    toolName,
    {
      failureKind: 'invalid_arguments',
      inputSummary: '{}',
      output: 'Tool error: recipient is required',
      success: false,
    },
    new Set([toolName]),
    definitions,
  )

  assert.match(result.output, /Exact argument schema for send_message/)
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
// unfiltered into executeToolSpec.
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

  const result = executeToolSpec(
    { names: ['send_message', 'team_search'] },
    allowedDefinitions,
    resolved.descriptors,
  )
  const output = JSON.parse(result.output) as {
    tools: Array<{ name: string }>
    unknownNames?: string[]
  }
  assert.deepEqual(output.tools.map((tool) => tool.name), ['team_search'])
  assert.deepEqual(output.unknownNames, ['send_message'])
})


test('tool_spec returns current executor schemas, including namespaced requests, without widening access', () => {
  const terminal = {
    toolName: 'terminal_session_start',
    description: 'Open the approved terminal.',
    inputSchema: { type: 'object', properties: { root: { enum: ['projects'] } }, required: ['root'] },
  }
  const currentView = buildBuiltinToolsetView(definitions, 0).descriptors
  const before = JSON.stringify(currentView)
  const names = ['default.terminal_session_start', 'send_message', 'executor_command_run']
  const result = executeToolSpec({ names }, definitions, [...currentView, terminal])
  const output = JSON.parse(result.output)
  assert.deepEqual(output.tools, [
    { name: terminal.toolName, description: terminal.description, inputSchema: terminal.inputSchema },
    { name: definitions[1]!.id, description: definitions[1]!.description, inputSchema: definitions[1]!.parameters },
  ])
  assert.deepEqual(output.unknownNames, ['executor_command_run'])
  assert.equal(JSON.stringify(currentView), before)
  // A delegate without the machine binding cannot discover its parent's tools.
  const delegated = JSON.parse(executeToolSpec({ names }, definitions, currentView).output)
  assert.deepEqual(delegated.unknownNames, ['default.terminal_session_start', 'executor_command_run'])
})

test('tool_spec uses the current MCP view after a tool is dropped', () => {
  const tool = { toolName: 'connected_tool', description: 'Loaded tool', inputSchema: { type: 'object' } }
  const view = [tool]
  assert.equal(JSON.parse(executeToolSpec({ names: [tool.toolName] }, [], view).output).tools.length, 1)
  view.pop()
  const dropped = JSON.parse(executeToolSpec({ names: [tool.toolName] }, [], view).output)
  assert.deepEqual(dropped.unknownNames, [tool.toolName])
})
