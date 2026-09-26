import {
  KB_DOCUMENT_COMPOSE_TOOL_ID,
  KB_DOCUMENT_EDIT_TOOL_ID,
  type BuiltinToolDefinition,
  type ToolSchemaDescriptor,
} from '@nessie/runtime'

import type { AgenticToolResult } from './tool-types.js'

export const DEFAULT_BUILTIN_INLINE_TOOL_LIMIT = 20
export const BUILTIN_TOOL_SPEC_NAME = 'tool_spec'

// Seeded from expected high-frequency calls. Replace intuition with ToolCall
// frequency data once enough production history is available. The document
// tools reference their runtime constants because their hot-set membership is
// load-bearing: `composeAvailable` in run-inference.ts raises the output cap by
// name, and a compose demoted to the stub tier would truncate streamed
// documents at the ordinary cap.
export const BUILTIN_HOT_TOOL_IDS = [
  'react',
  'web_search',
  'web_fetch',
  'team_search',
  'message_search',
  'people_search',
  'channel_find',
  'nessie_link',
  'delegate',
  KB_DOCUMENT_COMPOSE_TOOL_ID,
  KB_DOCUMENT_EDIT_TOOL_ID,
] as const

const BUILTIN_HOT_TOOL_ID_SET = new Set<string>(BUILTIN_HOT_TOOL_IDS)

/**
 * The most full-descriptor characters a run's own grants may add to the hot
 * set (about 6k tokens). The fixed set above is chosen for every agent; a tool
 * an agent was deliberately given — its policy's explicit `true`s and the
 * project tools this run was lent — is chosen for this one, and arriving as a
 * stub cost a `tool_spec` round trip per tool before the first real action.
 * Promotion stops at this budget, so a policy that grants dozens of tools
 * cannot turn the deferred view back into the fully inline one. Measured with
 * the same `JSON.stringify` of a full descriptor the provider receives.
 */
export const BUILTIN_PROMOTED_SCHEMA_BUDGET_CHARS = 24_000

export const BUILTIN_STUB_INPUT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: true,
  description: 'Call tool_spec first for the exact argument schema.',
}

const TOOL_SPEC_DESCRIPTOR: ToolSchemaDescriptor = {
  toolName: BUILTIN_TOOL_SPEC_NAME,
  description:
    'Return the full descriptions and exact argument schemas for tools available in this run. '
    + 'This lookup does not change the available tool list.',
  inputSchema: {
    type: 'object',
    properties: {
      names: {
        type: 'array',
        items: { type: 'string' },
        description: 'Exact tool names from the current tool list to inspect.',
      },
    },
    required: ['names'],
    additionalProperties: false,
  },
}

export type BuiltinToolsetView = {
  descriptors: ToolSchemaDescriptor[]
  stubbedIds: Set<string>
  toolSpecEnabled: boolean
}

const fullDescriptor = (tool: BuiltinToolDefinition): ToolSchemaDescriptor => ({
  toolName: tool.id,
  description: tool.description,
  inputSchema: tool.parameters,
})

const stubDescriptor = (tool: BuiltinToolDefinition): ToolSchemaDescriptor => ({
  toolName: tool.id,
  description: tool.summary,
  inputSchema: BUILTIN_STUB_INPUT_SCHEMA,
})

export const resolveBuiltinInlineToolLimit = (
  raw = process.env['NESSIE_BUILTIN_INLINE_TOOL_LIMIT'],
): number => {
  if (raw === undefined) return DEFAULT_BUILTIN_INLINE_TOOL_LIMIT
  const parsed = Number(raw)
  return Number.isInteger(parsed) && parsed >= 0
    ? parsed
    : DEFAULT_BUILTIN_INLINE_TOOL_LIMIT
}

export type BuiltinToolsetPromotion = {
  /**
   * Tools this run should see in full, highest priority first. Ids outside
   * `definitions` are ignored, so only an allowed tool can be promoted.
   */
  promotedIds?: readonly string[]
  promotedSchemaBudgetChars?: number
}

/**
 * The run's own grants that fit the promotion budget, in priority order. A
 * tool too large for what is left stays a stub and a smaller one after it may
 * still fit; the walk is deterministic, so the array stays byte-stable.
 */
const promotedWithinBudget = (
  definitions: BuiltinToolDefinition[],
  promotion: BuiltinToolsetPromotion,
): Set<string> => {
  const byId = new Map(definitions.map((tool) => [tool.id, tool]))
  const budget = promotion.promotedSchemaBudgetChars ?? BUILTIN_PROMOTED_SCHEMA_BUDGET_CHARS
  const promoted = new Set<string>()
  let spent = 0
  for (const id of promotion.promotedIds ?? []) {
    const tool = byId.get(id)
    if (!tool || BUILTIN_HOT_TOOL_ID_SET.has(id) || promoted.has(id)) continue
    const cost = JSON.stringify(fullDescriptor(tool)).length
    if (spent + cost > budget) continue
    spent += cost
    promoted.add(id)
  }
  return promoted
}

/**
 * Build the immutable builtin view once per run. Unlike deferred MCP tools,
 * `tool_spec` returns schemas as tool output and never mutates this array, so
 * the one-time schema-token estimate and the provider prompt-cache prefix stay
 * valid for every inference call in the run.
 */
export const buildBuiltinToolsetView = (
  definitions: BuiltinToolDefinition[],
  inlineToolLimit = resolveBuiltinInlineToolLimit(),
  promotion: BuiltinToolsetPromotion = {},
): BuiltinToolsetView => {
  if (definitions.length <= inlineToolLimit) {
    return {
      descriptors: definitions.map(fullDescriptor),
      stubbedIds: new Set(),
      toolSpecEnabled: false,
    }
  }

  const promoted = promotedWithinBudget(definitions, promotion)
  const stubbedIds = new Set(
    definitions
      .filter((tool) => !BUILTIN_HOT_TOOL_ID_SET.has(tool.id) && !promoted.has(tool.id))
      .map((tool) => tool.id),
  )
  // Nothing left to look up means nothing to offer the lookup for.
  const toolSpecEnabled = stubbedIds.size > 0
  return {
    descriptors: [
      ...definitions.map((tool) =>
        stubbedIds.has(tool.id) ? stubDescriptor(tool) : fullDescriptor(tool),
      ),
      ...(toolSpecEnabled ? [TOOL_SPEC_DESCRIPTOR] : []),
    ],
    stubbedIds,
    toolSpecEnabled,
  }
}

export const executeToolSpec = (
  args: Record<string, unknown>,
  allowedDefinitions: BuiltinToolDefinition[],
  availableDescriptors: readonly ToolSchemaDescriptor[],
): AgenticToolResult => {
  const requestedNames = Array.isArray(args['names'])
    ? args['names'].filter((name): name is string => typeof name === 'string')
    : []
  // The current view already contains only authorized tools. Full builtin
  // definitions replace its deferred stubs; executor and loaded MCP schemas
  // come from this run's view, never from another run or the global registry.
  const byName = new Map([
    ...availableDescriptors.map((tool) => [tool.toolName, tool] as const),
    ...allowedDefinitions.map((tool) => [tool.id, fullDescriptor(tool)] as const),
  ])
  // `default.ticket_create` is how a namespaced tool protocol (Meta's) spells
  // `ticket_create`; answer the tool it means rather than calling it unknown.
  const resolveName = (name: string): string => {
    if (byName.has(name)) return name
    const separator = name.indexOf('.')
    const bare = separator > 0 ? name.slice(separator + 1) : name
    return byName.has(bare) ? bare : name
  }
  const resolvedNames = requestedNames.map(resolveName)
  const tools = resolvedNames.flatMap((name) => {
    const definition = byName.get(name)
    return definition
      ? [{
        name: definition.toolName,
        description: definition.description,
        inputSchema: definition.inputSchema,
      }]
      : []
  })
  const unknownNames = resolvedNames.filter((name) => !byName.has(name))

  return {
    inputSummary: `names=${requestedNames.length}`,
    output: JSON.stringify({
      tools,
      ...(unknownNames.length > 0
        ? {
          unknownNames,
          message:
            'Unknown or unavailable tool name(s). Use exact names from the current tool list.',
        }
        : {}),
    }, null, 2),
    success: true,
  }
}

export const appendStubbedBuiltinSchema = (
  toolName: string,
  result: AgenticToolResult,
  stubbedIds: ReadonlySet<string>,
  definitions: BuiltinToolDefinition[],
): AgenticToolResult => {
  if (result.success || result.failureKind !== 'invalid_arguments' || !stubbedIds.has(toolName)) return result
  const definition = definitions.find((tool) => tool.id === toolName)
  if (!definition) return result
  return {
    ...result,
    output:
      `${result.output}\n\nExact argument schema for ${toolName}:\n`
      + JSON.stringify(definition.parameters, null, 2),
  }
}
