import assert from 'node:assert/strict'
import test from 'node:test'
import type { ProviderMessage } from '@nessie/runtime'
import { runAgenticLoop } from '../src/run/agentic-loop.js'
import {
  estimateMessageTokens,
  estimateMessagesTokens,
  trimConversationToFit,
} from '../src/run/context-management.js'

const makeInvocation = (overrides: Partial<Record<string, unknown>> = {}) => ({
  invocationId: '11111111-1111-1111-1111-111111111111',
  latencyMs: 1,
  model: 'gpt-5-mini',
  operationType: 'chat' as const,
  provider: 'openai' as const,
  requestId: 'req-1',
  usage: { totalTokens: 10 },
  ...overrides,
})

test('runAgenticLoop executes tool calls and feeds tool results into the next turn', async () => {
  const inferenceInputs: ProviderMessage[][] = []
  const emittedText: string[] = []

  const result = await runAgenticLoop({
    budget: {
      maxIterations: 4,
      maxToolCalls: 4,
      maxWallclockMs: 10_000,
    },
    callbacks: {
      onIterationStart: async () => {},
      onToolCallStart: async () => {},
      onToolCallEnd: async () => {},
      onTextDelta: async (delta) => {
        emittedText.push(delta)
      },
      onBudgetExhausted: async () => {},
    },
    executeTool: async (toolName, args) => {
      assert.equal(toolName, 'document_read')
      assert.deepEqual(args, { query: 'docs/provider-system-and-frontend-architecture.md' })
      return {
        inputSummary: 'document query',
        output: 'Architecture guidance',
        success: true,
      }
    },
    initialMessages: [{ content: 'Check the docs.', role: 'user' }],
    runInference: async (messages) => {
      inferenceInputs.push(messages)
      if (inferenceInputs.length === 1) {
        return {
          correlationId: 'corr-1',
          finishReason: 'tool-call',
          invocations: [makeInvocation()],
          model: 'gpt-5-mini',
          outputText: '',
          provider: 'openai',
          requestId: 'req-1',
          toolCalls: [
            {
              arguments: { query: 'docs/provider-system-and-frontend-architecture.md' },
              toolCallId: 'call_1',
              toolName: 'document_read',
            },
          ],
        }
      }

      assert.deepEqual(messages.at(-2), {
        content: null,
        role: 'assistant',
        toolCalls: [
          {
            arguments: { query: 'docs/provider-system-and-frontend-architecture.md' },
            toolCallId: 'call_1',
            toolName: 'document_read',
          },
        ],
      })
      assert.deepEqual(messages.at(-1), {
        content: 'Architecture guidance',
        role: 'tool',
        toolCallId: 'call_1',
      })

      return {
        correlationId: 'corr-1',
        finishReason: 'stop',
        invocations: [
          makeInvocation({
            invocationId: '22222222-2222-2222-2222-222222222222',
            requestId: 'req-2',
          }),
        ],
        model: 'gpt-5-mini',
        outputText: 'Use the shared provider facade pattern.',
        provider: 'openai',
        requestId: 'req-2',
        toolCalls: [],
      }
    },
    tools: [
      {
        description: 'Read project documentation.',
        inputSchema: {
          properties: {
            query: { type: 'string' },
          },
          required: ['query'],
          type: 'object',
        },
        toolName: 'document_read',
      },
    ],
  })

  assert.equal(result.finalText, 'Use the shared provider facade pattern.')
  assert.equal(result.iterations, 2)
  assert.equal(result.toolCallsUsed, 1)
  assert.deepEqual(emittedText, ['Use the shared provider facade pattern.'])
})

test('trimConversationToFit keeps assistant tool calls paired with tool results', () => {
  const assistantToolGroup: ProviderMessage[] = [
    {
      content: null,
      role: 'assistant',
      toolCalls: [
        {
          arguments: { query: 'policy' },
          toolCallId: 'call_1',
          toolName: 'document_read',
        },
      ],
    },
    {
      content: 'Policy contents',
      role: 'tool',
      toolCallId: 'call_1',
    },
  ]

  const messages: ProviderMessage[] = [
    { content: 'System instructions', role: 'system' },
    { content: 'x'.repeat(500), role: 'user' },
    ...assistantToolGroup,
  ]

  const maxTokens =
    estimateMessageTokens(messages[0]!)
    + estimateMessagesTokens(assistantToolGroup)
    + 4
  const trimmed = trimConversationToFit(messages, maxTokens)

  assert.deepEqual(trimmed, [messages[0]!, ...assistantToolGroup])
})

test('runAgenticLoop enforces the maxTokens budget', async () => {
  const exhausted: string[] = []

  const result = await runAgenticLoop({
    budget: {
      maxIterations: 2,
      maxToolCalls: 2,
      maxTokens: 5,
      maxWallclockMs: 10_000,
    },
    callbacks: {
      onIterationStart: async () => {},
      onToolCallStart: async () => {},
      onToolCallEnd: async () => {},
      onTextDelta: async () => {},
      onBudgetExhausted: async (reason) => {
        exhausted.push(reason)
      },
    },
    executeTool: async () => ({
      inputSummary: '',
      output: '',
      success: true,
    }),
    initialMessages: [{ content: 'Hi', role: 'user' }],
    runInference: async () => ({
      correlationId: 'corr-2',
      finishReason: 'stop',
      invocations: [
        makeInvocation({
          invocationId: '33333333-3333-3333-3333-333333333333',
          usage: { totalTokens: 6 },
        }),
      ],
      model: 'gpt-5-mini',
      outputText: 'Too long',
      provider: 'openai',
      requestId: 'req-3',
      toolCalls: [],
    }),
    tools: [],
  })

  assert.equal(result.exhaustedBudget, 'tokens')
  assert.equal(result.totalTokensUsed, 6)
  assert.deepEqual(exhausted, ['tokens'])
})
