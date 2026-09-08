import assert from 'node:assert/strict'
import test from 'node:test'

import type { InferenceResult, ProviderMessage } from '@nessie/runtime'
import {
  EMPTY_OUTPUT_FINALIZATION_INSTRUCTION,
  EMPTY_OUTPUT_TERMINAL_MESSAGE,
  OUTPUT_LENGTH_FINALIZATION_INSTRUCTION,
  runAgenticLoop,
  type BudgetLimits,
} from './agentic-loop.js'
import { classifyBudgetStop } from './execute/budget-stop.js'
import type { LoopResumeState } from './loop-resume.js'

const HIGH = 1_000_000

const budget = (over: Partial<BudgetLimits>): BudgetLimits => ({
  maxIterations: HIGH,
  maxToolCalls: HIGH,
  maxWallclockMs: HIGH,
  maxTokens: HIGH,
  maxCostCents: HIGH,
  toolTimeoutMs: HIGH,
  ...over,
})

// Always asks for one tool call so the loop never terminates naturally, and
// carries a bit of assistant text so we can assert it survives the cap stop.
const toolCallInference = (outputText: string): InferenceResult => ({
  correlationId: undefined,
  finishReason: undefined,
  invocations: [],
  model: 'test-model',
  outputText,
  provider: 'openai',
  requestId: 'req-1',
  toolCalls: [{ arguments: { n: Math.random() }, toolCallId: 'tc-1', toolName: 'noop' }],
})

const noopCallbacks = () => ({
  onIterationStart: async () => undefined,
  onToolCallStart: async () => undefined,
  onToolCallEnd: async () => undefined,
  onTextDelta: async () => undefined,
  onBudgetExhausted: async () => undefined,
})

const initial: ProviderMessage[] = [{ content: 'go', role: 'user' }]

const runCapped = (over: Partial<BudgetLimits>) =>
  runAgenticLoop({
    budget: budget(over),
    callbacks: noopCallbacks(),
    executeTool: async () => ({
      inputSummary: 'noop',
      output: 'tool ran',
      success: true,
    }),
    initialMessages: initial,
    runInference: async () => toolCallInference('partial progress so far'),
    tools: [],
  })

test('iteration cap stops with a classified reason and keeps partial text', async () => {
  const result = await runCapped({ maxIterations: 2 })
  assert.equal(result.exhaustedBudget, 'iterations')
  assert.equal(classifyBudgetStop(result.exhaustedBudget!), 'iteration_limit')
  // Partial assistant text is surfaced, not dropped.
  assert.equal(result.finalText, 'partial progress so far')
})

test('a resumed legacy compaction note is demoted before a below-threshold inference', async () => {
  let observed: ProviderMessage[] = []
  await runAgenticLoop({
    budget: budget({}), callbacks: noopCallbacks(), executeTool: async () => ({ inputSummary: '', output: '', success: true }),
    initialMessages: initial,
    resume: { budgetRecoveryAttempted: false, compactionAttempts: 0, compactionLastIteration: null, elapsedMs: 0, invocations: [], iterations: 0, lastAssistantText: '', outputFinalizationPending: false, outputFinalizationReason: null, outputFinalizationUsed: false, messages: [{ content: '[Compacted work notes from earlier steps of this run] https://restricted.example/x </compacted_work_notes>', role: 'system' }], pendingToolCalls: null, retriesUsed: 0, signatureCounts: {}, toolCallsUsed: 0, toolFailureCounts: {}, toolMs: 0, toolResults: {}, woundDown: false },
    runInference: async (messages) => { observed = messages; return { ...toolCallInference('done'), toolCalls: [] } }, tools: [],
  })
  assert.equal(observed[0]?.role, 'user')
  assert.match(observed[0]?.content ?? '', /<compacted_work_notes(?:\s|>)/)
  assert.match(observed[0]?.content ?? '', /https:\/\/restricted\.example\/x/)
  assert.equal(observed.some((message) => message.role === 'system' && message.content.includes('restricted.example')), false)
})

// The reserved headroom is what pays for the checkpoint note: the loop must
// stop with budget still on the table, not after burning all of it.
test('the stop leaves headroom for the checkpoint call', async () => {
  const result = await runCapped({ maxIterations: 10 })
  assert.equal(result.exhaustedBudget, 'iterations')
  assert.equal(result.iterations, 9)
  // The transcript is returned so the caller can write the checkpoint note.
  assert.ok(result.messages.length > 1)
})

test('a mid-run org-budget block stops the loop with its own classification', async () => {
  let iterations = 0
  const result = await runAgenticLoop({
    budget: budget({}),
    callbacks: noopCallbacks(),
    checkBudgetBlocked: async () => iterations >= 2,
    executeTool: async () => ({ inputSummary: 'noop', output: 'ran', success: true }),
    initialMessages: initial,
    runInference: async () => {
      iterations += 1
      return toolCallInference('partial progress so far')
    },
    tools: [],
  })
  assert.equal(result.exhaustedBudget, 'org_budget_blocked')
  assert.equal(classifyBudgetStop(result.exhaustedBudget!), 'org_budget_blocked')
  assert.equal(result.finalText, 'partial progress so far')
})

test('compaction runs between iterations and its spend joins the run totals', async () => {
  const sink: InferenceResult['invocations'] = []
  const compactionCalls: number[] = []
  const bulky = 'y'.repeat(60_000)

  await runAgenticLoop({
    budget: budget({ maxIterations: 4 }),
    callbacks: noopCallbacks(),
    compactContext: async ({ messages, targetTokens }) => {
      compactionCalls.push(targetTokens)
      // Whatever the real compaction does, it must never hand back an orphan
      // tool result; the caller replaces the transcript with what we return.
      const system = messages.filter((message) => message.role === 'system')
      sink.push({ usage: { totalTokens: 25 } } as unknown as InferenceResult['invocations'][number])
      return [...system, { content: 'compacted work notes', role: 'system' }]
    },
    contextPlan: { availableTokens: 1_000, targetTokens: 600, triggerTokens: 800 },
    executeTool: async () => ({ inputSummary: 'big', output: bulky, success: true }),
    initialMessages: initial,
    invocationSink: sink,
    runInference: async () => toolCallInference('working'),
    tools: [],
  })

  assert.ok(compactionCalls.length > 0, 'expected at least one compaction attempt')
  assert.deepEqual(compactionCalls, compactionCalls.map(() => 600))
  // Compaction is inference the run paid for.
  assert.ok(sink.some((invocation) => invocation.usage.totalTokens === 25))
})

test('tool-call cap stops with the tool_call_limit classification', async () => {
  const result = await runCapped({ maxToolCalls: 1 })
  assert.equal(result.exhaustedBudget, 'tool_calls')
  assert.equal(classifyBudgetStop(result.exhaustedBudget!), 'tool_call_limit')
  assert.equal(result.finalText, 'partial progress so far')
})

test('token usage over the cap classifies as token_limit', async () => {
  const result = await runAgenticLoop({
    budget: budget({ maxTokens: 100 }),
    callbacks: noopCallbacks(),
    executeTool: async () => ({ inputSummary: 'noop', output: 'ran', success: true }),
    initialMessages: initial,
    runInference: async () => ({
      correlationId: undefined,
      finishReason: undefined,
      invocations: [
        { usage: { totalTokens: 500 } } as unknown as InferenceResult['invocations'][number],
      ],
      model: 'test-model',
      outputText: 'partial',
      provider: 'openai',
      requestId: 'req-1',
      toolCalls: [{ arguments: {}, toolCallId: 'tc-1', toolName: 'noop' }],
    }),
    tools: [],
  })
  assert.equal(result.exhaustedBudget, 'tokens')
  assert.equal(classifyBudgetStop(result.exhaustedBudget!), 'token_limit')
})

test('invocationSink captures partial spend even when the loop throws', async () => {
  // First inference succeeds (records an invocation + asks for a tool call);
  // the second throws a fatal, non-retryable error. The caller's sink must still
  // hold the first invocation so the failed run's token spend stays attributable.
  const sink: InferenceResult['invocations'] = []
  const inv = (id: string): InferenceResult['invocations'][number] =>
    ({ invocationId: id, usage: { totalTokens: 10 } }) as unknown as InferenceResult['invocations'][number]

  let call = 0
  await assert.rejects(
    runAgenticLoop({
      budget: budget({}),
      callbacks: noopCallbacks(),
      executeTool: async () => ({ inputSummary: 'noop', output: 'ran', success: true }),
      initialMessages: initial,
      invocationSink: sink,
      runInference: async () => {
        call += 1
        if (call === 1) {
          return {
            correlationId: undefined,
            finishReason: undefined,
            invocations: [inv('inv-1')],
            model: 'test-model',
            outputText: 'working',
            provider: 'openai',
            requestId: 'req-1',
            toolCalls: [{ arguments: {}, toolCallId: 'tc-1', toolName: 'noop' }],
          }
        }
        throw new Error('provider exploded')
      },
      tools: [],
    }),
    /provider exploded/,
  )

  assert.equal(sink.length, 1)
  assert.equal(sink[0]?.invocationId, 'inv-1')
})

test('natural completion carries no budget stop', async () => {
  const result = await runAgenticLoop({
    budget: budget({}),
    callbacks: noopCallbacks(),
    executeTool: async () => ({ inputSummary: 'noop', output: 'ran', success: true }),
    initialMessages: initial,
    runInference: async () => ({
      correlationId: undefined,
      finishReason: undefined,
      invocations: [],
      model: 'test-model',
      outputText: 'final answer',
      provider: 'openai',
      requestId: 'req-1',
      toolCalls: [],
    }),
    tools: [],
  })
  assert.equal(result.exhaustedBudget, null)
  assert.equal(result.finalText, 'final answer')
})

test('the loop never retains or emits bypassed secret material', async () => {
  const token = ['sk', 'proj', 'abcdefghijklmnopqrstuv'].join('-')
  let providerMessages: ProviderMessage[] = []
  let emitted = ''
  const callbacks = {
    ...noopCallbacks(),
    onTextDelta: async (delta: string) => {
      emitted += delta
    },
  }
  const result = await runAgenticLoop({
    budget: budget({}),
    callbacks,
    executeTool: async () => ({ inputSummary: 'noop', output: 'ran', success: true }),
    initialMessages: [{ content: `use ${token}`, role: 'user' }],
    runInference: async (messages) => {
      providerMessages = messages
      return finalAnswerInference(`I found ${token}`)
    },
    tools: [],
  })
  const serialized = JSON.stringify(providerMessages)
  assert.doesNotMatch(serialized, /abcdefghijklmnopqrstuv/)
  assert.doesNotMatch(result.finalText, /abcdefghijklmnopqrstuv/)
  assert.doesNotMatch(emitted, /abcdefghijklmnopqrstuv/)
  assert.match(result.finalText, new RegExp(`sk-proj-${'•'.repeat(12)}`))
})

test('oversized tool results are truncated before entering the loop context', async () => {
  let capturedMessages: ProviderMessage[] = []
  let turn = 0
  await runAgenticLoop({
    // Two iterations of real work plus the reserved graceful-stop headroom.
    budget: budget({ maxIterations: 3 }),
    callbacks: noopCallbacks(),
    executeTool: async () => ({
      inputSummary: 'big',
      // ~200k chars of MCP-style output with no per-tool cap of its own.
      output: 'Z'.repeat(200_000),
      success: true,
    }),
    initialMessages: initial,
    runInference: async (messages) => {
      turn += 1
      if (turn === 2) capturedMessages = messages
      return toolCallInference('working')
    },
    tools: [],
  })

  const toolMessage = capturedMessages.find((m) => m.role === 'tool')
  assert.ok(toolMessage, 'expected a tool result message in context')
  const content = (toolMessage as { content: string }).content
  assert.ok(content.length < 200_000, 'tool result should have been truncated')
  // Middle-out: the head and the tail of the result both survive the cut.
  assert.match(content, /\n\n\[\.\.\. truncated \d+ chars \.\.\.\]\n\n/)
  assert.ok(content.startsWith('Z'.repeat(1_000)))
  assert.ok(content.endsWith('Z'.repeat(1_000)))
})

// --- Wind-down (spec §3a) ---

const finalAnswerInference = (outputText: string): InferenceResult => ({
  correlationId: undefined,
  finishReason: 'stop',
  invocations: [],
  model: 'test-model',
  outputText,
  provider: 'openai',
  requestId: 'req-1',
  toolCalls: [],
})

test('wind-down injects the instruction once and the model hands over naturally', async () => {
  let windDownFired = 0
  let sawInstruction = false
  const result = await runAgenticLoop({
    budget: budget({ maxIterations: 10 }),
    callbacks: noopCallbacks(),
    executeTool: async () => ({ inputSummary: 'noop', output: 'ran', success: true }),
    initialMessages: initial,
    onWindDown: () => {
      windDownFired += 1
    },
    runInference: async (messages) => {
      sawInstruction = messages.some(
        (m) => m.role === 'system' && typeof m.content === 'string'
          && m.content.includes('WRAP UP NOW'),
      )
      return sawInstruction
        ? finalAnswerInference('here is what I have; X remains')
        : toolCallInference('working...')
    },
    tools: [],
    windDownInstruction: 'WRAP UP NOW',
  })
  assert.equal(result.woundDown, true)
  assert.equal(result.exhaustedBudget, null)
  assert.equal(result.finalText, 'here is what I have; X remains')
  assert.equal(windDownFired, 1)
  const injected = result.messages.filter(
    (m) => m.role === 'system' && typeof m.content === 'string'
      && m.content.includes('WRAP UP NOW'),
  )
  assert.equal(injected.length, 1)
})

test('without a wind-down instruction nothing is injected', async () => {
  const result = await runCapped({ maxIterations: 6 })
  assert.equal(result.woundDown, false)
  assert.equal(
    result.messages.some(
      (m) => m.role === 'system' && typeof m.content === 'string'
        && m.content.includes('WRAP UP')),
    false,
  )
})

test('a model that ignores wind-down still hits the hard stop with a checkpointable transcript', async () => {
  const result = await runAgenticLoop({
    budget: budget({ maxIterations: 10 }),
    callbacks: noopCallbacks(),
    executeTool: async () => ({ inputSummary: 'noop', output: 'ran', success: true }),
    initialMessages: initial,
    runInference: async () => toolCallInference('still going'),
    tools: [],
    windDownInstruction: 'WRAP UP NOW',
  })
  assert.equal(result.woundDown, true)
  assert.equal(result.exhaustedBudget, 'iterations')
  assert.equal(result.finalText, 'still going')
  assert.ok(result.messages.length > 1)
})

// Counters that outlive one execution (horizontal scaling, phase 3.1).
//
// The circuit breaker and the retry budget count failures, and a run that
// crash-loops sees the same failures over and over on different workers. Both
// therefore ride in the crash checkpoint: without that, every re-claim hands
// the run a clean breaker and a full six retries, and a tool that has failed
// since the first execution is retried forever.

const resumeStateFrom = (over: Partial<LoopResumeState> = {}): LoopResumeState => ({
  budgetRecoveryAttempted: false,
  compactionAttempts: 0,
  compactionLastIteration: null,
  elapsedMs: 0,
  invocations: [],
  iterations: 1,
  lastAssistantText: '',
  outputFinalizationPending: false,
  outputFinalizationReason: null,
  outputFinalizationUsed: false,
  messages: [{ content: 'go', role: 'user' }],
  pendingToolCalls: null,
  retriesUsed: 0,
  signatureCounts: {},
  toolCallsUsed: 0,
  toolFailureCounts: {},
  toolMs: 0,
  toolResults: {},
  woundDown: false,
  ...over,
})

test('a length result at the budget cap keeps its partial answer and never dispatches calls', async () => {
  let dispatched = 0
  const result = await runAgenticLoop({
    budget: budget({ maxTokens: 100 }),
    callbacks: noopCallbacks(),
    executeTool: async () => {
      dispatched += 1
      return { inputSummary: 'write', output: 'must not run', success: true }
    },
    initialMessages: initial,
    runInference: async () => ({
      ...toolCallInference('research findings retained'),
      finishReason: 'length',
      invocations: [{ usage: { totalTokens: 100 } } as InferenceResult['invocations'][number]],
    }),
    tools: [],
  })
  assert.equal(result.exhaustedBudget, 'tokens')
  assert.equal(result.finalText, 'research findings retained')
  assert.equal(dispatched, 0)
  assert.equal(result.messages.some((message) => message.role === 'assistant'), false)
})

test('answer reserve triggers compaction before the ordinary context threshold', async () => {
  let compactions = 0
  await runAgenticLoop({
    budget: budget({}),
    callbacks: noopCallbacks(),
    compactContext: async () => {
      compactions += 1
      return [{ content: 'compacted evidence', role: 'system' }]
    },
    contextPlan: { availableTokens: 100, targetTokens: 60, triggerTokens: 80 },
    executeTool: async () => ({ inputSummary: 'noop', output: 'ran', success: true }),
    initialMessages: [{ content: 'x'.repeat(200), role: 'user' }],
    maxOutputTokens: 80,
    runInference: async () => finalAnswerInference('answer'),
    tools: [],
  })
  assert.equal(compactions, 1)
})

test('normal compaction spend can stop the run before the main model call', async () => {
  const sink: InferenceResult['invocations'] = []
  let calls = 0
  const result = await runAgenticLoop({
    budget: budget({ maxTokens: 100 }),
    callbacks: noopCallbacks(),
    compactContext: async () => {
      sink.push({ usage: { totalTokens: 90 } } as InferenceResult['invocations'][number])
      return [{ content: 'compacted', role: 'system' }]
    },
    contextPlan: { availableTokens: 100, targetTokens: 60, triggerTokens: 20 },
    executeTool: async () => ({ inputSummary: 'noop', output: 'ran', success: true }),
    initialMessages: [{ content: 'x'.repeat(100), role: 'user' }],
    invocationSink: sink,
    maxOutputTokens: 10,
    runInference: async () => {
      calls += 1
      return finalAnswerInference('must not run')
    },
    tools: [],
  })
  assert.equal(calls, 0)
  assert.equal(result.exhaustedBudget, 'tokens')
})

test('zero output headroom stops before an invalid provider request', async () => {
  let calls = 0
  const result = await runAgenticLoop({
    budget: budget({ maxTokens: 10 }),
    callbacks: noopCallbacks(),
    executeTool: async () => ({ inputSummary: 'noop', output: 'ran', success: true }),
    initialMessages: initial,
    invocationSink: [{ usage: { totalTokens: 5 } } as InferenceResult['invocations'][number]],
    maxOutputTokens: 4,
    runInference: async () => {
      calls += 1
      return finalAnswerInference('must not run')
    },
    tools: [],
  })
  assert.equal(calls, 0)
  assert.equal(result.exhaustedBudget, 'tokens')
})

test('budget-zero output admission compacts retained context and retries once', async () => {
  const sink: InferenceResult['invocations'] = [
    { usage: { totalTokens: 60 } } as InferenceResult['invocations'][number],
  ]
  const checkpoints: LoopResumeState[] = []
  let compactions = 0
  let targetTokens: number | undefined
  let calls = 0
  const result = await runAgenticLoop({
    budget: budget({ maxTokens: 100 }),
    callbacks: {
      ...noopCallbacks(),
      // The durable checkpoint serializer snapshots these arrays. Mirror that
      // boundary here so the pre-utility snapshot cannot be mutated in place
      // by the later utility and main inference.
      onCheckpoint: async (state) => {
        checkpoints.push({ ...state, invocations: [...state.invocations], messages: [...state.messages] })
      },
    },
    compactContext: async ({ targetTokens: target }) => {
      compactions += 1
      targetTokens = target
      // The utility invocation is metered before the main call is re-admitted.
      sink.push({ usage: { totalTokens: 5 } } as InferenceResult['invocations'][number])
      return [{ content: 'saved working notes', role: 'system' }]
    },
    // The physical context has plenty of space. This compaction is solely
    // because the run envelope has no output left after the retained turn.
    contextPlan: { availableTokens: 1_000, targetTokens: 600, triggerTokens: 800 },
    executeTool: async () => ({ inputSummary: 'noop', output: 'ran', success: true }),
    initialMessages: [{ content: 'x'.repeat(160), role: 'user' }],
    invocationSink: sink,
    maxOutputTokens: 80,
    runInference: async () => {
      calls += 1
      return finalAnswerInference('answer from compacted context')
    },
    tools: [],
  })

  assert.equal(compactions, 1)
  assert.equal(targetTokens, 20, 'the recovery target leaves output room inside the run budget')
  assert.equal(calls, 1)
  assert.equal(result.exhaustedBudget, null)
  assert.equal(result.finalText, 'answer from compacted context')
  assert.equal(checkpoints.length, 3, 'the attempt, utility result, and recovered state reach the durable checkpoint seam')
  assert.equal(checkpoints.at(-1)?.invocations.length, 2, 'the utility call is part of the durable run spend')
  assert.ok(
    checkpoints.at(-1)?.messages.some((message) => message.content === 'saved working notes'),
    'the durable state carries the compacted transcript before the recovered main call',
  )

  let resumedCompactions = 0
  const resumed = await runAgenticLoop({
    budget: budget({ maxTokens: 100 }),
    callbacks: noopCallbacks(),
    compactContext: async () => {
      resumedCompactions += 1
      return [{ content: 'must not run', role: 'system' }]
    },
    contextPlan: { availableTokens: 1_000, targetTokens: 600, triggerTokens: 800 },
    executeTool: async () => ({ inputSummary: 'noop', output: 'ran', success: true }),
    initialMessages: [],
    maxOutputTokens: 80,
    resume: checkpoints[0],
    runInference: async () => finalAnswerInference('must not run'),
    tools: [],
  })
  assert.equal(resumedCompactions, 0, 'the pre-utility checkpoint preserves the one-shot attempt')
  assert.equal(resumed.exhaustedBudget, 'tokens')
})

test('budget-zero output admission does not compact when schemas exhaust the run allowance', async () => {
  let compactions = 0
  const result = await runAgenticLoop({
    budget: budget({ maxTokens: 30 }),
    callbacks: noopCallbacks(),
    compactContext: async () => {
      compactions += 1
      return [{ content: 'must not run', role: 'system' }]
    },
    contextPlan: { availableTokens: 1_000, targetTokens: 600, triggerTokens: 800 },
    executeTool: async () => ({ inputSummary: 'noop', output: 'ran', success: true }),
    initialMessages: initial,
    maxOutputTokens: 20,
    runInference: async () => finalAnswerInference('must not run'),
    tools: [{ description: 'x'.repeat(120), inputSchema: {}, toolName: 'large_schema' }],
  })

  assert.equal(compactions, 0)
  assert.equal(result.exhaustedBudget, 'tokens')
})

test('zero-output recovery checkpoints its rebuilt notes before its own spend stops the run', async () => {
  const sink: InferenceResult['invocations'] = [
    { usage: { totalTokens: 60 } } as InferenceResult['invocations'][number],
  ]
  const checkpoints: LoopResumeState[] = []
  let calls = 0
  const result = await runAgenticLoop({
    budget: budget({ maxTokens: 100 }),
    callbacks: {
      ...noopCallbacks(),
      onCheckpoint: async (state) => {
        checkpoints.push({ ...state, invocations: [...state.invocations], messages: [...state.messages] })
      },
    },
    compactContext: async () => {
      sink.push({ usage: { totalTokens: 40 } } as InferenceResult['invocations'][number])
      return [{ content: 'saved working notes', role: 'system' }]
    },
    contextPlan: { availableTokens: 1_000, targetTokens: 600, triggerTokens: 800 },
    executeTool: async () => ({ inputSummary: 'noop', output: 'ran', success: true }),
    initialMessages: [{ content: 'x'.repeat(160), role: 'user' }],
    invocationSink: sink,
    maxOutputTokens: 80,
    runInference: async () => {
      calls += 1
      return finalAnswerInference('must not run')
    },
    tools: [],
  })

  assert.equal(calls, 0)
  assert.equal(result.exhaustedBudget, 'tokens')
  assert.equal(checkpoints.at(-1)?.budgetRecoveryAttempted, true)
  assert.equal(checkpoints.at(-1)?.invocations.length, 2)
  assert.ok(checkpoints.at(-1)?.messages.some((message) => message.content === 'saved working notes'))
})

test('forced compaction re-admits its spend and rebuilt context before inference', async () => {
  const sink: InferenceResult['invocations'] = []
  let requestedOutputTokens: number | undefined
  await runAgenticLoop({
    budget: budget({ maxTokens: 100 }),
    callbacks: noopCallbacks(),
    compactContext: async () => {
      sink.push({ usage: { totalTokens: 40 } } as InferenceResult['invocations'][number])
      return [{ content: 'short', role: 'system' }]
    },
    contextPlan: { availableTokens: 50, targetTokens: 30, triggerTokens: 45 },
    executeTool: async () => ({ inputSummary: 'noop', output: 'ran', success: true }),
    initialMessages: [{ content: 'x'.repeat(200), role: 'user' }],
    invocationSink: sink,
    maxOutputTokens: 80,
    runInference: async (_messages, _captured, options) => {
      requestedOutputTokens = options?.maxOutputTokens
      return finalAnswerInference('answer')
    },
    tools: [],
  })
  assert.equal(requestedOutputTokens, 44)
})

test('a length-limited turn gets one no-tools finalisation without replaying work', async () => {
  const noTools: boolean[] = []
  let calls = 0
  const result = await runAgenticLoop({
    budget: budget({}),
    callbacks: noopCallbacks(),
    executeTool: async () => ({ inputSummary: 'noop', output: 'ran', success: true }),
    initialMessages: initial,
    runInference: async (_messages, _captured, options) => {
      noTools.push(options?.noTools === true)
      calls += 1
      return calls === 1
        ? { ...finalAnswerInference('partial research'), finishReason: 'length' }
        : finalAnswerInference('concise answer from retained research')
    },
    tools: [{ description: 'would be dangerous if replayed', inputSchema: {}, toolName: 'write' }],
  })
  assert.equal(result.finalText, 'concise answer from retained research')
  assert.deepEqual(noTools, [false, true])
  assert.ok(result.messages.some((message) => message.role === 'system'
    && message.content === OUTPUT_LENGTH_FINALIZATION_INSTRUCTION))
})

test('an empty provider success after tools gets one checkpointed no-tools finalisation', async () => {
  const noTools: boolean[] = []
  let checkpoint: LoopResumeState | undefined
  let calls = 0
  let toolExecutions = 0
  await assert.rejects(runAgenticLoop({
    budget: budget({}),
    callbacks: {
      ...noopCallbacks(),
      onCheckpoint: async (state) => {
        if (!state.outputFinalizationPending) return
        checkpoint = {
          ...state,
          invocations: [...state.invocations],
          messages: [...state.messages],
          toolResults: { ...state.toolResults },
        }
        throw new Error('simulated worker drain after checkpoint')
      },
    },
    executeTool: async () => {
      toolExecutions += 1
      return { inputSummary: 'created board', output: 'board saved', success: true }
    },
    initialMessages: initial,
    runInference: async (_messages, _captured, options) => {
      noTools.push(options?.noTools === true)
      calls += 1
      if (calls === 1) return toolCallInference('')
      return finalAnswerInference('')
    },
    tools: [{ description: 'creates one board', inputSchema: {}, toolName: 'board_create' }],
  }), /simulated worker drain/)
  assert.equal(toolExecutions, 1, 'the completed side effect is not replayed')
  assert.deepEqual(noTools, [false, false])
  assert.ok(checkpoint)
  assert.equal(checkpoint.outputFinalizationReason, 'empty_output')
  assert.equal(checkpoint.outputFinalizationUsed, true)
  assert.equal(checkpoint.lengthFinalizationPending, true)
  assert.equal(checkpoint.lengthFinalizationUsed, true, 'a rolling older worker still sees that recovery was spent')
  assert.ok(checkpoint.messages.some((message) => message.role === 'system'
    && message.content === EMPTY_OUTPUT_FINALIZATION_INSTRUCTION))

  const resumedNoTools: boolean[] = []
  const resumed = await runAgenticLoop({
    budget: budget({}),
    callbacks: noopCallbacks(),
    executeTool: async () => {
      throw new Error('must not replay the completed board creation')
    },
    initialMessages: initial,
    resume: checkpoint,
    runInference: async (_messages, _captured, options) => {
      resumedNoTools.push(options?.noTools === true)
      return finalAnswerInference('The board is ready.')
    },
    tools: [{ description: 'creates one board', inputSchema: {}, toolName: 'board_create' }],
  })
  assert.equal(resumed.finalText, 'The board is ready.')
  assert.deepEqual(resumedNoTools, [true])
})

test('a second empty provider success surfaces a classified terminal reply', async () => {
  const noTools: boolean[] = []
  let calls = 0
  const result = await runAgenticLoop({
    budget: budget({}),
    callbacks: noopCallbacks(),
    executeTool: async () => ({ inputSummary: 'noop', output: 'ran', success: true }),
    initialMessages: initial,
    runInference: async (_messages, _captured, options) => {
      noTools.push(options?.noTools === true)
      calls += 1
      return finalAnswerInference('')
    },
    tools: [{ description: 'must never run during recovery', inputSchema: {}, toolName: 'write' }],
  })

  assert.equal(calls, 2)
  assert.deepEqual(noTools, [false, true])
  assert.equal(result.finalText, EMPTY_OUTPUT_TERMINAL_MESSAGE)
  assert.equal(result.incompleteReason, 'empty_provider_response')
})

test('a resumed run does not repeat an output-length finalisation', async () => {
  let calls = 0
  const result = await runAgenticLoop({
    budget: budget({}),
    callbacks: noopCallbacks(),
    executeTool: async () => ({ inputSummary: 'noop', output: 'ran', success: true }),
    initialMessages: initial,
    resume: resumeStateFrom({ outputFinalizationReason: 'length', outputFinalizationUsed: true }),
    runInference: async () => {
      calls += 1
      return { ...finalAnswerInference('retained partial'), finishReason: 'length' }
    },
    tools: [],
  })
  assert.equal(calls, 1)
  assert.match(result.finalText, /retained partial/)
  assert.match(result.finalText, /response limit/)
})

test('a reclaimed output-length recovery never re-enables tools', async () => {
  const noTools: boolean[] = []
  const result = await runAgenticLoop({
    budget: budget({}),
    callbacks: noopCallbacks(),
    executeTool: async () => {
      throw new Error('must not dispatch a tool during recovery')
    },
    initialMessages: initial,
    resume: resumeStateFrom({
      outputFinalizationPending: true,
      outputFinalizationReason: 'length',
      outputFinalizationUsed: true,
      messages: [
        ...initial,
        { content: 'partial research', role: 'assistant' },
        { content: OUTPUT_LENGTH_FINALIZATION_INSTRUCTION, role: 'system' },
      ],
    }),
    runInference: async (_messages, _captured, options) => {
      noTools.push(options?.noTools === true)
      return finalAnswerInference('recovered concise answer')
    },
    tools: [{ description: 'must stay absent', inputSchema: {}, toolName: 'write' }],
  })
  assert.equal(result.finalText, 'recovered concise answer')
  assert.deepEqual(noTools, [true])
})

test('a legacy-only pending finalisation checkpoint resumes no-tools recovery', async () => {
  const noTools: boolean[] = []
  const legacy: Partial<LoopResumeState> & {
    lengthFinalizationPending?: boolean
    lengthFinalizationUsed?: boolean
  } = {
    ...resumeStateFrom({
    messages: [
      ...initial,
      { content: 'partial research', role: 'assistant' },
      { content: OUTPUT_LENGTH_FINALIZATION_INSTRUCTION, role: 'system' },
    ],
    }),
  }
  legacy.lengthFinalizationPending = true
  legacy.lengthFinalizationUsed = true
  delete legacy.outputFinalizationPending
  delete legacy.outputFinalizationReason
  delete legacy.outputFinalizationUsed

  const result = await runAgenticLoop({
    budget: budget({}),
    callbacks: noopCallbacks(),
    executeTool: async () => {
      throw new Error('legacy recovery must not dispatch tools')
    },
    initialMessages: initial,
    resume: legacy as LoopResumeState,
    runInference: async (_messages, _captured, options) => {
      noTools.push(options?.noTools === true)
      return finalAnswerInference('recovered answer')
    },
    tools: [{ description: 'must stay absent', inputSchema: {}, toolName: 'write' }],
  })
  assert.equal(result.finalText, 'recovered answer')
  assert.deepEqual(noTools, [true])
})

test('a resumed run inherits the breaker counts its earlier executions earned', async () => {
  let executions = 0
  let call = 0
  const states: LoopResumeState[] = []

  const result = await runAgenticLoop({
    budget: budget({ maxIterations: 5 }),
    callbacks: {
      ...noopCallbacks(),
      onCheckpoint: async (state) => {
        states.push(state)
      },
    },
    executeTool: async () => {
      executions += 1
      return { inputSummary: 'flaky', output: 'upstream said no', success: false }
    },
    initialMessages: initial,
    // Two failures already, on an executor that has since died.
    resume: resumeStateFrom({ toolFailureCounts: { flaky: 2 } }),
    runInference: async () => ({
      ...toolCallInference('trying again'),
      // Distinct ids and arguments: a repeated call would be answered from the
      // recorder or stopped by loop detection, and neither is what is on trial.
      toolCalls: [{ arguments: { n: (call += 1) }, toolCallId: `tc-${call}`, toolName: 'flaky' }],
    }),
    tools: [],
  })

  assert.equal(
    executions,
    1,
    'the third failure trips the breaker, so only one more call ever reaches the tool',
  )
  assert.ok(
    result.messages.some((message) => message.role === 'tool'
      && typeof message.content === 'string'
      && message.content.includes('disabled after 3 consecutive failures')),
    'and the model is told the tool is disabled instead of being handed a fourth failure',
  )
  assert.deepEqual(
    states.at(-1)?.toolFailureCounts,
    { flaky: 3 },
    'the count the next executor inherits carries this execution\'s failure too',
  )
})

test('a resumed run does not get a fresh retry budget', async () => {
  let attempts = 0
  const result = await runAgenticLoop({
    budget: budget({ maxIterations: 5 }),
    callbacks: noopCallbacks(),
    executeTool: async () => ({ inputSummary: 'noop', output: 'ran', success: true }),
    initialMessages: initial,
    // Six retries is the whole allowance; earlier executions spent it.
    resume: resumeStateFrom({ retriesUsed: 6 }),
    runInference: async () => {
      attempts += 1
      throw new Error('json parse error: unexpected token')
    },
    tools: [],
  })

  assert.equal(attempts, 1, 'a spent budget buys no further attempt')
  assert.equal(
    result.finalText,
    'Too many retries. Please try again later.',
    'the run surfaces the exhausted-retries message rather than retrying from zero',
  )
})

test('the retries an execution spends are carried in its checkpoints', async () => {
  const states: LoopResumeState[] = []
  let attempts = 0

  await runAgenticLoop({
    budget: budget({ maxIterations: 3 }),
    callbacks: {
      ...noopCallbacks(),
      onCheckpoint: async (state) => {
        states.push(state)
      },
    },
    executeTool: async () => ({ inputSummary: 'noop', output: 'ran', success: true }),
    initialMessages: initial,
    runInference: async () => {
      attempts += 1
      if (attempts === 1) throw new Error('json parse error: unexpected token')
      return toolCallInference('recovered')
    },
    tools: [],
  })

  assert.equal(attempts > 1, true, 'the format error was retried at least once')
  assert.equal(
    states.at(-1)?.retriesUsed,
    1,
    'so the next executor starts one retry down rather than at six',
  )
})
