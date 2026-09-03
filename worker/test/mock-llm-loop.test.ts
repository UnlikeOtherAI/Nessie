import assert from 'node:assert/strict'
import test from 'node:test'

import { createMockRunInference, loadScenario } from '@nessie/mock-llm'
import { runAgenticLoop, type BudgetLimits } from '../src/run/agentic-loop.js'

// Demonstrates the migration shape for tests that hand-stub `runInference`
// (see src/run/agentic-loop.test.ts): the same scenario files that drive the
// smoke and load harnesses plug straight into the loop's inference seam.

const HIGH = 1_000_000

const budget: BudgetLimits = {
  maxCostCents: HIGH,
  maxIterations: HIGH,
  maxTokens: HIGH,
  maxToolCalls: HIGH,
  maxWallclockMs: HIGH,
  toolTimeoutMs: HIGH,
}

const noopCallbacks = () => ({
  onBudgetExhausted: async () => undefined,
  onIterationStart: async () => undefined,
  onTextDelta: async () => undefined,
  onToolCallEnd: async () => undefined,
  onToolCallStart: async () => undefined,
})

test('agentic loop completes a scripted tool-call scenario end to end', async () => {
  const toolExecutions: string[] = []
  const result = await runAgenticLoop({
    budget,
    callbacks: noopCallbacks(),
    executeTool: async (toolName) => {
      toolExecutions.push(toolName)
      return {
        inputSummary: toolName,
        output: '[{"label":"mock-llm-smoke"}]',
        success: true,
      }
    },
    initialMessages: [{ content: 'Which channels exist?', role: 'user' }],
    runInference: createMockRunInference(await loadScenario('channel-list-tool')),
    tools: [],
  })

  assert.deepEqual(toolExecutions, ['channel_list'])
  assert.equal(result.toolCallsUsed, 1)
  assert.equal(result.iterations, 2)
  assert.equal(result.exhaustedBudget, null)
  assert.equal(
    result.finalText,
    'The team has a handful of channels, including the one we are talking in right now.',
  )
  assert.equal(result.invocations.length, 2)
})

test('scripted scenarios replay deterministically', async () => {
  const runOnce = async () =>
    runAgenticLoop({
      budget,
      callbacks: noopCallbacks(),
      executeTool: async () => ({
        inputSummary: 'noop',
        output: 'tool ran',
        success: true,
      }),
      initialMessages: [{ content: 'go', role: 'user' }],
      runInference: createMockRunInference(await loadScenario('channel-list-tool')),
      tools: [],
    })

  const [first, second] = await Promise.all([runOnce(), runOnce()])
  assert.equal(first.finalText, second.finalText)
  assert.equal(first.iterations, second.iterations)
  assert.equal(first.toolCallsUsed, second.toolCallsUsed)
})
