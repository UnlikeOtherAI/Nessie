import assert from 'node:assert/strict'
import test from 'node:test'
import type { InferenceResult, InvocationRecord } from '@nessie/runtime'
import { runAgenticLoop } from './agentic-loop.js'
import { coverProviderInputComponent } from './execute/provenanced-provider-input.js'
import { FOLLOW_UP_LIMIT_MESSAGE, reviewFollowUp } from './follow-up-review.js'
import type { LoopResumeState } from './loop-resume.js'

const response = (outputText: string, toolCalls: InferenceResult['toolCalls'] = []): InferenceResult => ({
  outputText, toolCalls, invocations: [], model: 'test', provider: 'openai', requestId: 'test', finishReason: 'stop',
})
const base = () => ({
  budget: {
    maxIterations: 100, maxToolCalls: 100, maxWallclockMs: 100_000,
    maxTokens: 100_000, maxCostCents: 100_000, toolTimeoutMs: 1_000,
  },
  callbacks: {
    onIterationStart: async () => {}, onTextDelta: async () => {}, onBudgetExhausted: async () => {},
    onToolCallStart: async () => {}, onToolCallEnd: async () => {},
  },
  initialMessages: [{ role: 'user' as const, content: 'Read the disk size once, then stop.' }],
  tools: [],
  executeTool: async () => ({ success: true, inputSummary: 'disk', output: '1 TB' }),
})

for (const promise of ['I will check.', 'Mrknu na to.', 'voy a mirarlo', 'lemme chek']) {
  test(`a structured follow-up completes one command without repeating it: ${promise}`, async () => {
    let turn = 0
    let calls = 0
    let checks = 0
    const snapshots: LoopResumeState[] = []
    const input = base()
    const result = await runAgenticLoop({
      ...input,
      callbacks: { ...input.callbacks, onCheckpoint: async (state) => { snapshots.push(structuredClone(state)) } },
      runInference: async () => {
        turn += 1
        if (turn === 1) return response(promise)
        if (turn === 2) return response('', [{ toolName: 'disk', toolCallId: 'disk-1', arguments: {} }])
        return response('Disk: 1 TB.')
      },
      reviewCompletion: async () => ({
        needsFollowUp: checks++ === 0, reason: 'Use the disk result to finish.', invocations: [],
      }),
      executeTool: async () => {
        calls += 1
        return { success: true, inputSummary: 'disk', output: '1 TB' }
      },
    })
    assert.equal(result.finalText, 'Disk: 1 TB.')
    assert.equal(calls, 1)
    assert.equal(result.toolCallsUsed, 1)
    assert.equal(checks, 2)
    assert.ok(snapshots.some((state) => state.followUpAttempts === 1))
  })
}

test('an explicit blocker ends without trying unavailable tools', async () => {
  const result = await runAgenticLoop({
    ...base(), runInference: async () => response('Approve machine access to continue.'),
    reviewCompletion: async () => ({ needsFollowUp: false, reason: 'The person must approve.', invocations: [] }),
    executeTool: async () => { throw new Error('must not run') },
  })
  assert.equal(result.iterations, 1)
  assert.equal(result.toolCallsUsed, 0)
})

test('empty-response recovery keeps tools and reviews a premature recovered answer', async () => {
  let turn = 0
  let calls = 0
  let reviews = 0
  const noTools: boolean[] = []
  const result = await runAgenticLoop({
    ...base(),
    tools: [{ toolName: 'disk', description: 'Read disk size', inputSchema: {} }],
    runInference: async (_messages, _captured, options) => {
      noTools.push(options?.noTools === true)
      turn += 1
      if (turn === 1) return response('')
      if (turn === 2) return response('I will check the disk.')
      if (turn === 3) return response('', [{ toolName: 'disk', toolCallId: 'disk-1', arguments: {} }])
      return response('Disk: 1 TB.')
    },
    reviewCompletion: async () => ({
      needsFollowUp: reviews++ === 0, reason: 'Finish the authorized disk read.', invocations: [],
    }),
    executeTool: async () => {
      calls += 1
      return { success: true, inputSummary: 'disk', output: '1 TB' }
    },
  })
  assert.equal(result.finalText, 'Disk: 1 TB.')
  assert.equal(calls, 1)
  assert.equal(reviews, 2)
  assert.deepEqual(noTools, [false, false, false, false])
})

test('repeated premature answers stop after two corrections, including after crash resume', async () => {
  const checkpoints: LoopResumeState[] = []
  const input = base()
  const run = async (resume?: LoopResumeState) => runAgenticLoop({
    ...input, ...(resume ? { resume } : {}),
    callbacks: { ...input.callbacks, onCheckpoint: async (state) => { checkpoints.push(structuredClone(state)) } },
    runInference: async () => response('I will do it.'),
    reviewCompletion: async () => ({ needsFollowUp: true, reason: 'No action yet.', invocations: [] }),
  })
  const first = await run()
  assert.equal(first.incompleteReason, 'follow_up_limit')
  assert.equal(first.iterations, 3)
  assert.equal(first.finalText, FOLLOW_UP_LIMIT_MESSAGE)
  const checkpoint = checkpoints.find((state) => state.followUpAttempts === 2)
  assert.ok(checkpoint)
  const resumed = await run(checkpoint)
  assert.equal(resumed.incompleteReason, 'follow_up_limit')
  assert.equal(resumed.iterations, checkpoint.iterations + 1)
})

test('review cancellation wins over a decision to finish', async () => {
  let cancelled = false
  const result = await runAgenticLoop({
    ...base(), checkCancelled: async () => cancelled,
    runInference: async () => response('Done.'),
    reviewCompletion: async () => {
      cancelled = true
      return { needsFollowUp: false, reason: 'Done.', invocations: [] }
    },
  })
  assert.equal(result.cancelled, true)
})

test('approval suspension never asks the completion reviewer to bypass it', async () => {
  const result = await runAgenticLoop({
    ...base(),
    runInference: async () => response('', [{ toolName: 'disk', toolCallId: 'disk-1', arguments: {} }]),
    executeTool: async () => ({
      success: false, inputSummary: 'disk', output: 'Approve access',
      pendingApproval: { approvalId: 'approval', notice: 'Approve access', toolName: 'disk' },
    }),
    reviewCompletion: async () => { throw new Error('must not review a suspended run') },
  })
  assert.equal(result.pendingApproval?.approvalId, 'approval')
})

test('review spend stops continuation at the original run budget', async () => {
  const result = await runAgenticLoop({
    ...base(), runInference: async () => response('I will check.'),
    reviewCompletion: async () => ({
      needsFollowUp: true, reason: 'Not done.',
      invocations: [{
        invocationId: 'review', requestId: 'review', provider: 'openai', model: 'test',
        operationType: 'chat', latencyMs: 0, usage: { totalTokens: 100_000 },
      }],
    }),
  })
  assert.equal(result.exhaustedBudget, 'tokens')
  assert.equal(result.iterations, 1)
  assert.equal(result.totalTokensUsed, 100_000)
})

test('the completion decision must be an actual boolean and a reason', async () => {
  const sink: InvocationRecord[] = []
  const messages = [{ role: 'user' as const, content: 'Read the disk once.' }]
  for (const output of ['Done', '{"needsFollowUp":"false","reason":"done"}', '{}']) {
    await assert.rejects(reviewFollowUp(async () => response(output), messages, 'I will check.', sink),
      /could not verify/)
  }
  const decision = await reviewFollowUp(
    async () => response('{"needsFollowUp":true,"reason":"The requested read was not performed."}'),
    messages, 'I will check.', sink,
  )
  assert.equal(decision.needsFollowUp, true)
})

/** The person's own turn, admitted as stored conversation. */
const asked = (content: string) => [coverProviderInputComponent({ role: 'user' as const, content }, 'conversation')]

const jev = (choice: 'complete' | 'unfinished', probability: number) => {
  let asked = 0
  return {
    asked: () => asked,
    decide: async () => {
      asked += 1
      return { completion: { type: 'choice' as const, choice, probabilities: { [choice]: probability } } }
    },
  }
}

test('a sure "complete" from Jev ends the turn without the generative review', async () => {
  const sink: InvocationRecord[] = []
  const gate = jev('complete', 0.95)
  let reviewed = 0
  const decision = await reviewFollowUp(async () => {
    reviewed += 1
    return response('{"needsFollowUp":true,"reason":"unused"}')
  }, asked('Kolik máme místa na disku?'), 'Na disku zbývá 1 TB.', sink, gate.decide)

  assert.equal(decision.needsFollowUp, false)
  assert.equal(gate.asked(), 1)
  assert.equal(reviewed, 0)
  assert.deepEqual(sink, [])
})

for (const [choice, probability] of [['complete', 0.7], ['unfinished', 0.99]] as const) {
  test(`Jev ${choice} at ${probability} leaves the turn to the generative review`, async () => {
    const gate = jev(choice, probability)
    const decision = await reviewFollowUp(
      async () => response('{"needsFollowUp":true,"reason":"The disk was never read."}'),
      asked('Kolik máme místa na disku?'), 'Mrknu na to.', [], gate.decide,
    )
    assert.equal(gate.asked(), 1)
    assert.equal(decision.needsFollowUp, true)
    assert.equal(decision.reason, 'The disk was never read.')
  })
}

test('a tool\u2019s pictures are not the request, and with no request left the full review runs', async () => {
  const gate = jev('complete', 0.99)
  let reviewed = 0
  const pictures = coverProviderInputComponent({ role: 'user' as const, content: '[screenshot]' }, 'tool_images')
  await reviewFollowUp(async () => {
    reviewed += 1
    return response('{"needsFollowUp":false,"reason":"done"}')
  }, [pictures], 'Hotovo.', [], gate.decide)
  assert.equal(gate.asked(), 0)
  assert.equal(reviewed, 1)
})
