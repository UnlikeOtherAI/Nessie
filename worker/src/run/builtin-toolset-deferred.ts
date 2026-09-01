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
  'workspace_search',
  'message_search',
  'people_search',
  'channel_find',
  'delegate',
  KB_DOCUMENT_COMPOSE_TOOL_ID,
  KB_DOCUMENT_EDIT_TOOL_ID,
] as const

const BUILTIN_HOT_TOOL_ID_SET = new Set<string>(BUILTIN_HOT_TOOL_IDS)

export const BUILTIN_STUB_INPUT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: true,
  description: 'Call tool_spec first for the exact argument schema.',
}

const TOOL_SPEC_DESCRIPTOR: ToolSchemaDescriptor = {
  toolName: BUILTIN_TOOL_SPEC_NAME,
  description:
    'Return the full descriptions and exact argument schemas for allowed builtin tools. '
    + 'This lookup does not change the available tool list.',
  inputSchema: {
    type: 'object',
    properties: {
      names: {
        type: 'array',
        items: { type: 'string' },
        description: 'Exact builtin tool names to inspect.',
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

/**
 * Build the immutable builtin view once per run. Unlike deferred MCP tools,
 * `tool_spec` returns schemas as tool output and never mutates this array, so
 * the one-time schema-token estimate and the provider prompt-cache prefix stay
 * valid for every inference call in the run.
 */
export const buildBuiltinToolsetView = (
  definitions: BuiltinToolDefinition[],
  inlineToolLimit = resolveBuiltinInlineToolLimit(),
): BuiltinToolsetView => {
  if (definitions.length <= inlineToolLimit) {
    return {
      descriptors: definitions.map(fullDescriptor),
      stubbedIds: new Set(),
      toolSpecEnabled: false,
    }
  }

  const stubbedIds = new Set(
    definitions
      .filter((tool) => !BUILTIN_HOT_TOOL_ID_SET.has(tool.id))
      .map((tool) => tool.id),
  )
  return {
    descriptors: [
      ...definitions.map((tool) =>
        stubbedIds.has(tool.id) ? stubDescriptor(tool) : fullDescriptor(tool),
      ),
      TOOL_SPEC_DESCRIPTOR,
    ],
    stubbedIds,
    toolSpecEnabled: true,
  }
}

export const executeBuiltinToolSpec = (
  args: Record<string, unknown>,
  allowedDefinitions: BuiltinToolDefinition[],
): AgenticToolResult => {
  const requestedNames = Array.isArray(args['names'])
    ? args['names'].filter((name): name is string => typeof name === 'string')
    : []
  const byName = new Map(allowedDefinitions.map((tool) => [tool.id, tool]))
  const tools = requestedNames.flatMap((name) => {
    const definition = byName.get(name)
    return definition
      ? [{
        name: definition.id,
        description: definition.description,
        inputSchema: definition.parameters,
      }]
      : []
  })
  const unknownNames = requestedNames.filter((name) => !byName.has(name))

  return {
    inputSummary: `names=${requestedNames.length}`,
    output: JSON.stringify({
      tools,
      ...(unknownNames.length > 0
        ? {
          unknownNames,
          message:
            'Unknown or unavailable builtin tool name(s). Use exact names from the current tool list.',
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
  if (result.success || !stubbedIds.has(toolName)) return result
  const definition = definitions.find((tool) => tool.id === toolName)
  if (!definition) return result
  return {
    ...result,
    output:
      `${result.output}\n\nExact argument schema for ${toolName}:\n`
      + JSON.stringify(definition.parameters, null, 2),
  }
}
