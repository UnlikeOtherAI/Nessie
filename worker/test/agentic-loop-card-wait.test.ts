import assert from 'node:assert/strict'
import test from 'node:test'

import { runAgenticLoop } from '../src/run/agentic-loop.js'

const invocation = {
  invocationId: '11111111-1111-1111-1111-111111111111',
  latencyMs: 1,
  model: 'gpt-5-mini',
  operationType: 'chat' as const,
  provider: 'openai' as const,
  requestId: 'req-1',
  usage: { totalTokens: 10 },
}

const cardTool = {
  description: 'Post an interactive card.',
  inputSchema: { properties: {}, type: 'object' as const },
  name: 'card_post',
}

/**
 * A card posted with `wait: true` stops the generation. Unlike an approval —
 * decided before dispatch — the card must exist before anybody can press it,
 * so the signal comes back from a settled tool result.
 */
test('a waiting card exits the loop with pendingInput and no further inference', async () => {
  let inferenceCalls = 0

  const result = await runAgenticLoop({
    budget: { maxIterations: 5, maxToolCalls: 5, maxWallclockMs: 10_000 },
    callbacks: {
      onBudgetExhausted: async () => {},
      onIterationStart: async () => {},
      onTextDelta: async () => {},
      onToolCallEnd: async () => {},
      onToolCallStart: async () => {},
    },
    executeTool: async () => ({
      inputSummary: 'title=Deploy hotfix',
      output: '{"cardId":"card-1","status":"open"}',
      pendingInput: { cardId: 'card-1' },
      success: true,
    }),
    initialMessages: [{ content: 'Ask me before deploying.', role: 'user' }],
    runInference: async () => {
      inferenceCalls += 1
      return {
        correlationId: 'corr-1',
        finishReason: 'tool-call',
        invocations: [invocation],
        model: 'gpt-5-mini',
        outputText: 'Sending you a card.',
        provider: 'openai',
        requestId: 'req-1',
        toolCalls: [
          { arguments: { wait: true }, toolCallId: 'call_1', toolName: 'card_post' },
        ],
      }
    },
    tools: [cardTool],
  })

  assert.deepEqual(result.pendingInput, { cardId: 'card-1' })
  // The run parks rather than ending: no budget was exhausted and it was not
  // cancelled, so the caller suspends instead of terminalizing.
  assert.equal(result.exhaustedBudget, null)
  assert.equal(result.cancelled, false)
  // The model is not asked to continue past a question it just posed.
  assert.equal(inferenceCalls, 1)
  // Whatever it said in the same turn is still delivered.
  assert.equal(result.finalText, 'Sending you a card.')
})

test('a card posted without wait leaves the loop running normally', async () => {
  let inferenceCalls = 0

  const result = await runAgenticLoop({
    budget: { maxIterations: 5, maxToolCalls: 5, maxWallclockMs: 10_000 },
    callbacks: {
      onBudgetExhausted: async () => {},
      onIterationStart: async () => {},
      onTextDelta: async () => {},
      onToolCallEnd: async () => {},
      onToolCallStart: async () => {},
    },
    executeTool: async () => ({
      inputSummary: 'title=FYI',
      output: '{"cardId":"card-2","status":"open"}',
      success: true,
    }),
    initialMessages: [{ content: 'Post a card.', role: 'user' }],
    runInference: async () => {
      inferenceCalls += 1
      if (inferenceCalls === 1) {
        return {
          correlationId: 'corr-1',
          finishReason: 'tool-call',
          invocations: [invocation],
          model: 'gpt-5-mini',
          outputText: '',
          provider: 'openai',
          requestId: 'req-1',
          toolCalls: [{ arguments: {}, toolCallId: 'call_1', toolName: 'card_post' }],
        }
      }
      return {
        correlationId: 'corr-1',
        finishReason: 'stop',
        invocations: [invocation],
        model: 'gpt-5-mini',
        outputText: 'Posted.',
        provider: 'openai',
        requestId: 'req-2',
        toolCalls: [],
      }
    },
    tools: [cardTool],
  })

  assert.equal(result.pendingInput ?? null, null)
  assert.equal(inferenceCalls, 2)
  assert.equal(result.finalText, 'Posted.')
})

/**
 * The other half of "one message, not two": having posted a card, the model is
 * told to stop talking, and the loop must let it. An empty final turn is
 * normally a provider fault worth one recovery attempt — and that recovery
 * asks in so many words for a final answer, which is exactly the duplicate
 * prose the card replaced. A tool that already delivered this turn to the
 * conversation excuses it.
 */
test('a card already in the conversation lets the run end without a word', async () => {
  let inferenceCalls = 0

  const result = await runAgenticLoop({
    budget: { maxIterations: 5, maxToolCalls: 5, maxWallclockMs: 10_000 },
    callbacks: {
      onBudgetExhausted: async () => {},
      onIterationStart: async () => {},
      onTextDelta: async () => {},
      onToolCallEnd: async () => {},
      onToolCallStart: async () => {},
    },
    executeTool: async () => ({
      deliveredToConversation: true,
      inputSummary: 'title=Sales agent',
      output: '{"cardId":"card-3","status":"open"}',
      success: true,
    }),
    initialMessages: [{ content: 'Propose a sales agent.', role: 'user' }],
    runInference: async () => {
      inferenceCalls += 1
      if (inferenceCalls === 1) {
        return {
          correlationId: 'corr-1',
          finishReason: 'tool-call',
          invocations: [invocation],
          model: 'gpt-5-mini',
          outputText: '',
          provider: 'openai',
          requestId: 'req-1',
          toolCalls: [{ arguments: {}, toolCallId: 'call_1', toolName: 'card_post' }],
        }
      }
      return {
        correlationId: 'corr-1',
        finishReason: 'stop',
        invocations: [invocation],
        model: 'gpt-5-mini',
        outputText: '',
        provider: 'openai',
        requestId: 'req-2',
        toolCalls: [],
      }
    },
    tools: [cardTool],
  })

  // Two turns: the card, then the silence. No third turn begging for prose.
  assert.equal(inferenceCalls, 2)
  assert.equal(result.finalText, '')
  assert.equal(result.incompleteReason, null)
})
