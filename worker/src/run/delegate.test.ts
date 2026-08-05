import assert from 'node:assert/strict'
import test from 'node:test'

import {
  BUILTIN_TOOL_DEFINITIONS,
  type InferenceResult,
  type ProviderMessage,
  type ToolSchemaDescriptor,
} from '@nessie/runtime'

import { runDelegate } from './delegate.js'
import type { McpToolset } from './mcp-toolset.js'
import { resolveAgentTools } from './tool-policy.js'

/**
 * `delegate` is an ordinary builtin for agent runs (spec §9): the model can
 * only fan discovery out to sub-agents if it is actually advertised. These
 * tests pin the advertisement contract and the sub-agent's isolated toolset.
 */

const enabledBuiltinIds = new Set(BUILTIN_TOOL_DEFINITIONS.map((tool) => tool.id))

const advertisedToolNames = (
  toolPolicy: Record<string, boolean> | null,
  agentKind: 'personal_assistant' | 'shared',
): string[] =>
  resolveAgentTools(
    enabledBuiltinIds,
    BUILTIN_TOOL_DEFINITIONS,
    toolPolicy,
    null,
    agentKind,
  ).descriptors.map((descriptor) => descriptor.toolName)

test('delegate is advertised to a personal assistant and to a shared agent', () => {
  assert.ok(advertisedToolNames(null, 'personal_assistant').includes('delegate'))
  assert.ok(advertisedToolNames(null, 'shared').includes('delegate'))
})

test('delegate is an ordinary builtin, not an explicit-grant tool', () => {
  const definition = BUILTIN_TOOL_DEFINITIONS.find((tool) => tool.id === 'delegate')
  assert.ok(definition)
  assert.notEqual(definition.requiresExplicitGrant, true)
  assert.notEqual(definition.personalAssistantOnly, true)
  assert.deepEqual(definition.parameters.required, ['task'])
  assert.deepEqual(Object.keys(definition.parameters.properties).sort(), ['hint', 'task'])
})

test('a toolPolicy deny removes delegate like any other builtin', () => {
  const names = advertisedToolNames({ delegate: false }, 'personal_assistant')
  assert.ok(!names.includes('delegate'))
  // Unrelated builtins are untouched by the deny.
  assert.ok(names.includes('web_search'))
})

const webSearchDescriptor: ToolSchemaDescriptor = {
  toolName: 'web_search',
  description: 'Search the web.',
  inputSchema: { type: 'object', properties: {} },
}

const emptyMcpToolset = (): McpToolset =>
  ({
    createView: () => ({
      descriptors: [],
      handledNames: new Set<string>(),
      dispatch: async () => {
        throw new Error('no MCP tools in this test')
      },
    }),
    timeoutErrorFor: () => null,
  }) as unknown as McpToolset

const inferenceResult = (
  over: Partial<InferenceResult> = {},
): InferenceResult => ({
  invocations: [],
  model: 'test-model',
  outputText: '',
  provider: 'openai' as InferenceResult['provider'],
  requestId: 'req-1',
  toolCalls: [],
  ...over,
})

test('a delegate sub-agent is never shown the delegate tool itself', async () => {
  const advertised: string[][] = []
  const result = await runDelegate(
    { task: 'Find the current pricing page.' },
    {
      mcpToolset: emptyMcpToolset(),
      runInference: async (
        _messages: ProviderMessage[],
        tools: ToolSchemaDescriptor[],
      ) => {
        advertised.push(tools.map((tool) => tool.toolName))
        return inferenceResult({ outputText: 'Pricing starts at $10/month.' })
      },
      executeBuiltinTool: async () => {
        throw new Error('not called')
      },
      // The caller (execute/agent-loop.ts) filters `delegate` out of the
      // sub-agent's builtins; the sub-agent advertises exactly what it is given.
      builtinDescriptors: [webSearchDescriptor],
      allowedBuiltinIds: new Set(['web_search']),
    },
  )

  assert.equal(result.success, true)
  assert.ok(advertised.length > 0)
  for (const names of advertised) {
    assert.deepEqual(names, ['web_search'])
  }
})

test('a sub-agent that calls delegate anyway is refused, not recursed', async () => {
  let turn = 0
  const result = await runDelegate(
    { task: 'Research competitors.', hint: 'web search' },
    {
      mcpToolset: emptyMcpToolset(),
      runInference: async () => {
        turn += 1
        return turn === 1
          ? inferenceResult({
            toolCalls: [
              { toolCallId: 'call-1', toolName: 'delegate', arguments: { task: 'deeper' } },
            ],
          })
          : inferenceResult({ outputText: 'Done.' })
      },
      executeBuiltinTool: async () => {
        throw new Error('not called')
      },
      builtinDescriptors: [webSearchDescriptor],
      allowedBuiltinIds: new Set(['web_search']),
    },
  )

  assert.equal(result.success, true)
  assert.equal(result.output, 'Done.')
  assert.equal(turn, 2)
})
