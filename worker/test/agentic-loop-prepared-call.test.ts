import assert from 'node:assert/strict'
import test from 'node:test'

import type { ProviderMessage } from '@nessie/runtime'

import { runAgenticLoop } from '../src/run/agentic-loop.js'

/**
 * A pressed card button's prepared call runs before any inference, exactly
 * like a re-entered batch, and a clean success needs no model turn at all
 * (docs/standards/agent-cards.md → "A prepared button runs its call").
 */

const prepared = {
  arguments: { day: 'friday', room: 'Aquarium', time: '14:00' },
  toolCallId: 'prepared_0123456789abcdef0123456789abcdef',
  toolName: 'room_book',
}

const loop = (
  outcome: { success: boolean; output: string },
  options: { cancelAfterBatch?: boolean; confirmed?: boolean } = {},
) => {
  let batches = 0
  const dispatched: Array<{ args: Record<string, unknown>; name: string }> = []
  const seen: ProviderMessage[][] = []
  const run = runAgenticLoop({
    budget: { maxIterations: 5, maxToolCalls: 5, maxWallclockMs: 10_000 },
    callbacks: {
      onBudgetExhausted: async () => {},
      onIterationStart: async () => {},
      onTextDelta: async () => {},
      onToolCallEnd: async () => {},
      onToolCallStart: async () => {},
    },
    checkCancelled: async () => options.cancelAfterBatch === true && batches > 0,
    confirmPrepared: async () => options.confirmed ?? true,
    executeTool: async (name, args) => {
      batches += 1
      dispatched.push({ args, name })
      return { inputSummary: 'room_book', output: outcome.output, success: outcome.success }
    },
    initialMessages: [{ content: 'Friday 14:00', role: 'user' }],
    preparedToolCalls: [prepared],
    runInference: async (messages) => {
      seen.push(structuredClone(messages))
      return {
        correlationId: 'corr-1',
        finishReason: 'stop',
        invocations: [],
        model: 'gpt-5-mini',
        outputText: 'The room was already taken on Friday, so nothing is booked.',
        provider: 'openai',
        requestId: 'req-1',
        toolCalls: [],
      }
    },
    tools: [],
  })
  return { dispatched, run, seen }
}

test('a prepared call that succeeds ends the run without asking the model', async () => {
  const { dispatched, run, seen } = loop({ output: '{"booked":true}', success: true })
  const result = await run

  assert.deepEqual(dispatched, [{ args: prepared.arguments, name: 'room_book' }])
  assert.equal(seen.length, 0)
  assert.equal(result.preparedCompleted, true)
  assert.equal(result.finalText, '')
  assert.equal(result.iterations, 0)
  assert.equal(result.toolCallsUsed, 1)
})

test('a prepared call that fails hands the turn to the model with its result', async () => {
  const { dispatched, run, seen } = loop({ output: 'Error: the room is taken', success: false })
  const result = await run

  assert.equal(dispatched.length, 1)
  assert.equal(seen.length, 1)
  assert.equal(result.preparedCompleted, undefined)
  assert.equal(result.finalText, 'The room was already taken on Friday, so nothing is booked.')
  // The model reads the call as its own, then the tool's answer.
  const [person, asked, answer] = seen[0]!
  assert.equal(person!.role, 'user')
  assert.deepEqual(asked, { content: null, role: 'assistant', toolCalls: [prepared] })
  assert.deepEqual(answer, { content: 'Error: the room is taken', role: 'tool', toolCallId: prepared.toolCallId })
})

test('a refusal returned as ordinary output is not taken for success', async () => {
  // The tool returned, so it counts as successful; only the result says it refused.
  const { run, seen } = loop({ output: 'You cannot book rooms in this building.', success: true }, { confirmed: false })
  const result = await run

  assert.equal(seen.length, 1, 'the model is asked to explain')
  assert.equal(result.preparedCompleted, undefined)
})

test('a stop pressed while the prepared call ran ends the run as cancelled', async () => {
  const { run, seen } = loop({ output: '{"booked":true}', success: true }, { cancelAfterBatch: true })
  const result = await run

  assert.equal(seen.length, 0)
  assert.equal(result.cancelled, true)
  assert.equal(result.preparedCompleted, undefined)
})
