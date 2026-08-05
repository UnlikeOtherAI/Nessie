import assert from 'node:assert/strict'
import test from 'node:test'

import type { ProviderMessage } from '@nessie/runtime'

import { runAgenticLoop } from '../src/run/agentic-loop.js'
import { FatalToolExecutionError } from '../src/run/tool-execution-errors.js'

const makeInvocation = () => ({
  invocationId: '11111111-1111-1111-1111-111111111111',
  latencyMs: 1,
  model: 'gpt-5-mini',
  operationType: 'chat' as const,
  provider: 'openai' as const,
  requestId: 'req-1',
  usage: { totalTokens: 10 },
})

const fatalLoopInput = (executeTool: () => Promise<never>) => ({
  budget: {
    maxIterations: 1,
    maxToolCalls: 1,
    maxWallclockMs: 10_000,
    toolTimeoutMs: 5,
  },
  callbacks: {
    onIterationStart: async () => {},
    onToolCallStart: async () => {},
    onToolCallEnd: async () => {},
    onTextDelta: async () => {},
    onBudgetExhausted: async () => {},
  },
  executeTool,
  initialMessages: [{ content: 'Start research.', role: 'user' }] as ProviderMessage[],
  runInference: async () => ({
    correlationId: 'corr-fatal',
    finishReason: 'tool-call',
    invocations: [makeInvocation()],
    model: 'gpt-5-mini',
    outputText: '',
    provider: 'openai' as const,
    requestId: 'req-fatal',
    toolCalls: [{
      arguments: { query: 'test' },
      toolCallId: 'call-fatal',
      toolName: 'mcp_research_start',
    }],
  }),
  tools: [],
})

test('fatal tool errors abort instead of becoming model-visible results', async () => {
  const fatal = new FatalToolExecutionError('fatal handoff invariant')
  const ended: Array<{ output: string; success: boolean }> = []
  await assert.rejects(
    runAgenticLoop({
      ...fatalLoopInput(async () => { throw fatal }),
      callbacks: {
        ...fatalLoopInput(async () => { throw fatal }).callbacks,
        onToolCallEnd: async (_name, output, _duration, success) => {
          ended.push({ output, success })
        },
      },
    }),
    fatal,
  )
  assert.deepEqual(ended, [{
    output: 'Tool execution could not be confirmed; retrying safely.',
    success: false,
  }])
})

test('fatal errors wait for every started same-batch sibling before retry', async () => {
  const fatal = new FatalToolExecutionError('fatal handoff invariant')
  let releaseSibling: (() => void) | undefined
  let siblingStartedResolve: (() => void) | undefined
  const siblingStarted = new Promise<void>((resolve) => {
    siblingStartedResolve = resolve
  })
  const endedTools: string[] = []
  let siblingFinished = false
  let loopSettled = false

  const loop = runAgenticLoop({
    budget: {
      maxIterations: 1,
      maxToolCalls: 2,
      maxWallclockMs: 10_000,
      toolTimeoutMs: 1_000,
    },
    callbacks: {
      onIterationStart: async () => {},
      onToolCallStart: async () => {},
      onToolCallEnd: async (name) => { endedTools.push(name) },
      onTextDelta: async () => {},
      onBudgetExhausted: async () => {},
    },
    executeTool: async (toolName) => {
      if (toolName === 'fatal_tool') throw fatal
      siblingStartedResolve?.()
      await new Promise<void>((resolve) => { releaseSibling = resolve })
      siblingFinished = true
      return { inputSummary: 'sibling', output: 'done', success: true }
    },
    initialMessages: [{ content: 'Run both.', role: 'user' }],
    runInference: async () => ({
      correlationId: 'corr-batch-fatal',
      finishReason: 'tool-call',
      invocations: [makeInvocation()],
      model: 'gpt-5-mini',
      outputText: '',
      provider: 'openai',
      requestId: 'req-batch-fatal',
      toolCalls: [
        {
          arguments: {},
          toolCallId: 'call-fatal',
          toolName: 'fatal_tool',
        },
        {
          arguments: {},
          toolCallId: 'call-sibling',
          toolName: 'sibling_tool',
        },
      ],
    }),
    tools: [],
  }).finally(() => {
    loopSettled = true
  })

  await siblingStarted
  await Promise.resolve()
  assert.equal(loopSettled, false)
  releaseSibling?.()
  await assert.rejects(loop, fatal)
  assert.equal(siblingFinished, true)
  assert.deepEqual(endedTools.sort(), ['fatal_tool', 'sibling_tool'])
})

test('a fatal batch rejection wins over an earlier callback failure', async () => {
  const fatal = new FatalToolExecutionError('fatal handoff invariant')
  const loop = runAgenticLoop({
    budget: {
      maxIterations: 1,
      maxToolCalls: 2,
      maxWallclockMs: 10_000,
    },
    callbacks: {
      onIterationStart: async () => {},
      onToolCallStart: async (name) => {
        if (name === 'broken_callback_tool') throw new Error('ordinary callback failure')
      },
      onToolCallEnd: async () => {},
      onTextDelta: async () => {},
      onBudgetExhausted: async () => {},
    },
    executeTool: async (toolName) => {
      if (toolName === 'fatal_tool') throw fatal
      return { inputSummary: toolName, output: 'done', success: true }
    },
    initialMessages: [{ content: 'Run both.', role: 'user' }],
    runInference: async () => ({
      correlationId: 'corr-mixed-rejection',
      finishReason: 'tool-call',
      invocations: [makeInvocation()],
      model: 'gpt-5-mini',
      outputText: '',
      provider: 'openai',
      requestId: 'req-mixed-rejection',
      toolCalls: [
        {
          arguments: {},
          toolCallId: 'call-ordinary',
          toolName: 'broken_callback_tool',
        },
        {
          arguments: {},
          toolCallId: 'call-fatal',
          toolName: 'fatal_tool',
        },
      ],
    }),
    tools: [],
  })

  await assert.rejects(loop, fatal)
})

test('a scoped fatal timeout aborts the loop', async () => {
  const fatal = new FatalToolExecutionError('ambiguous start timeout')
  let timeoutClassifications = 0
  await assert.rejects(
    runAgenticLoop({
      ...fatalLoopInput(async () => new Promise<never>(() => undefined)),
      toolTimeoutError: () => {
        timeoutClassifications += 1
        return fatal
      },
    }),
    fatal,
  )
  assert.equal(timeoutClassifications, 1)
})

test('an ordinary tool timeout remains a model-visible failure', async () => {
  const result = await runAgenticLoop(
    fatalLoopInput(async () => new Promise<never>(() => undefined)),
  )
  assert.equal(result.exhaustedBudget, 'tool_calls')
  assert.equal(result.toolCallsUsed, 1)
})

test('delivery is acknowledged only after callback and message incorporation', async () => {
  let acknowledgements = 0
  let inference = 0
  const result = await runAgenticLoop({
    // Two iterations of real work, plus the headroom the loop reserves for a
    // graceful stop (see loop-budget.ts).
    budget: { maxIterations: 3, maxToolCalls: 3, maxWallclockMs: 10_000 },
    callbacks: {
      onIterationStart: async () => {},
      onToolCallStart: async () => {},
      onToolCallEnd: async () => { assert.equal(acknowledgements, 0) },
      onTextDelta: async () => {},
      onBudgetExhausted: async () => {},
    },
    executeTool: async () => ({
      acknowledgeDelivery: () => { acknowledgements += 1 },
      inputSummary: 'research',
      output: '{"id":"rs_ticket"}',
      success: true,
    }),
    initialMessages: [{ content: 'Start.', role: 'user' }],
    runInference: async (messages) => {
      inference += 1
      if (inference === 1) {
        return {
          correlationId: 'corr-delivery',
          invocations: [makeInvocation()],
          model: 'gpt-5-mini',
          outputText: '',
          provider: 'openai',
          requestId: 'req-delivery-1',
          toolCalls: [{
            arguments: {},
            toolCallId: 'call-delivery',
            toolName: 'mcp_research_start',
          }],
        }
      }
      assert.equal(acknowledgements, 1)
      assert.equal(messages.at(-1)?.role, 'tool')
      return {
        correlationId: 'corr-delivery',
        invocations: [makeInvocation()],
        model: 'gpt-5-mini',
        outputText: 'Research started.',
        provider: 'openai',
        requestId: 'req-delivery-2',
        toolCalls: [],
      }
    },
    tools: [],
  })

  assert.equal(result.finalText, 'Research started.')
  assert.equal(acknowledgements, 1)
})

test('callback failure after a valid ticket does not acknowledge delivery', async () => {
  let acknowledgements = 0
  await assert.rejects(
    runAgenticLoop({
      budget: { maxIterations: 1, maxToolCalls: 1, maxWallclockMs: 10_000 },
      callbacks: {
        onIterationStart: async () => {},
        onToolCallStart: async () => {},
        onToolCallEnd: async () => { throw new Error('tool-end write failed') },
        onTextDelta: async () => {},
        onBudgetExhausted: async () => {},
      },
      executeTool: async () => ({
        acknowledgeDelivery: () => { acknowledgements += 1 },
        inputSummary: 'research',
        output: '{"id":"rs_ticket"}',
        success: true,
      }),
      initialMessages: [{ content: 'Start.', role: 'user' }],
      runInference: async () => ({
        correlationId: 'corr-callback-failure',
        invocations: [makeInvocation()],
        model: 'gpt-5-mini',
        outputText: '',
        provider: 'openai',
        requestId: 'req-callback-failure',
        toolCalls: [{
          arguments: {},
          toolCallId: 'call-callback-failure',
          toolName: 'mcp_research_start',
        }],
      }),
      tools: [],
    }),
    /tool-end write failed/,
  )
  assert.equal(acknowledgements, 0)
})
