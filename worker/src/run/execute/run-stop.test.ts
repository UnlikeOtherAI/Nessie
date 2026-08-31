import assert from 'node:assert/strict'
import test from 'node:test'

import type { RunExecuteJobPayload } from '@nessie/schemas'
import type { LoopResult } from '../agentic-loop.js'
import type { RunInference } from './run-inference.js'
import { prepareWindDownHandover, WIND_DOWN_INSTRUCTION } from './run-stop.js'
import { createConsumedSourceSink } from './disclosure-basis.js'
import type { ExecutionDependencies, RunContext } from './types.js'

const loopResult = (over: Partial<LoopResult> = {}): LoopResult => ({
  cacheReadTokens: 12_000,
  cancelled: false,
  effectiveTokensUsed: 31_000,
  exhaustedBudget: null,
  finalText: 'here is what I found; X remains',
  invocations: [],
  iterations: 5,
  messages: [{ content: 'go', role: 'user' }],
  toolCallsUsed: 3,
  toolMs: 10,
  totalCostCents: 4,
  totalTokensUsed: 40_000,
  wallclockMs: 1_000,
  woundDown: true,
  ...over,
})

const context = {
  agent: { id: 'agent-1' },
  boundAgentIds: [],
  // The checkpoint now carries the writing run's disclosure basis, so the
  // context needs the sink and the destination chain the basis is computed
  // against. An empty sink is the common case: an unrestricted run.
  channel: {
    id: 'channel-1',
    organizationId: 'org-1',
    projectId: 'project-1',
    teamId: 'team-1',
  },
  consumedSources: createConsumedSourceSink(),
  replyRootMessageId: 'root-1',
  run: { id: 'run-1', threadId: 'thread-1' },
  task: { id: 'task-1' },
} as unknown as RunContext

const inference = {
  runUtility: async () => ({
    invocations: [],
    outputText: '## State\nhalf done\n\n## Sources\n- https://example.com/a',
  }),
} as unknown as RunInference

const depsWith = (input: {
  upsert?: (arg: unknown) => Promise<{ id: string }>
  events?: unknown[]
}): ExecutionDependencies => ({
  prisma: {
    runCheckpoint: {
      upsert: input.upsert ?? (async () => ({ id: 'checkpoint-1' })),
    },
    taskEvent: {
      create: async (arg: unknown) => {
        input.events?.push(arg)
        return {}
      },
    },
  },
} as unknown as ExecutionDependencies)

test('a wound-down interactive run gets a quiet checkpoint and continuable metadata', async () => {
  const upserts: unknown[] = []
  const events: unknown[] = []
  const metadata = await prepareWindDownHandover(
    depsWith({
      events,
      upsert: async (arg) => {
        upserts.push(arg)
        return { id: 'checkpoint-9' }
      },
    }),
    { interactive: true } as unknown as RunExecuteJobPayload,
    context,
    { goal: 'research slack clones', inference, invocationSink: [], loopResult: loopResult(), priorGeneration: 0 },
  )
  assert.deepEqual(metadata, {
    checkpointId: 'checkpoint-9',
    continuable: true,
    runId: 'run-1',
    stopReason: 'wound_down',
  })
  const created = (upserts[0] as { create: { reason: string; generation: number } }).create
  assert.equal(created.reason, 'wound_down')
  assert.equal(created.generation, 1)
  assert.equal(events.length, 1)
})

test('a non-interactive wound-down run is checkpointed but not offered continue', async () => {
  const metadata = await prepareWindDownHandover(
    depsWith({}),
    {} as unknown as RunExecuteJobPayload,
    context,
    { goal: 'goal', inference, invocationSink: [], loopResult: loopResult(), priorGeneration: 2 },
  )
  assert.equal(metadata?.continuable, false)
  assert.equal(metadata?.stopReason, 'wound_down')
})

test('a failed checkpoint degrades to null — the run still completes normally', async () => {
  const metadata = await prepareWindDownHandover(
    depsWith({ upsert: async () => { throw new Error('db down') } }),
    { interactive: true } as unknown as RunExecuteJobPayload,
    context,
    { goal: 'goal', inference, invocationSink: [], loopResult: loopResult(), priorGeneration: 0 },
  )
  assert.equal(metadata, null)
})

test('the wind-down instruction forbids new work and asks for a plain handover', () => {
  assert.match(WIND_DOWN_INSTRUCTION, /Do not open new lines of work/)
  assert.match(WIND_DOWN_INSTRUCTION, /deliver your best\s+complete answer/i)
  assert.match(WIND_DOWN_INSTRUCTION, /what is done and what remains/)
})
