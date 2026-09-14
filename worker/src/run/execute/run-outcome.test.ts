import assert from 'node:assert/strict'
import test from 'node:test'

import { handleRunLoopOutcome } from './run-outcome.js'
import type { ExecutionDependencies, RunContext } from './types.js'
import { createConsumedSourceSink } from './disclosure-basis.js'
import type { LoopResult } from '../agentic-loop.js'

const IDS = {
  agent: '00000000-0000-4000-8000-000000000001',
  channel: '00000000-0000-4000-8000-000000000002',
  organization: '00000000-0000-4000-8000-000000000003',
  project: '00000000-0000-4000-8000-000000000007',
  run: '00000000-0000-4000-8000-000000000004',
  task: '00000000-0000-4000-8000-000000000005',
  team: '00000000-0000-4000-8000-000000000008',
  thread: '00000000-0000-4000-8000-000000000006',
}

test('an unrecovered empty provider response terminalizes the run as failed', async () => {
  const statuses: string[] = []
  const messages: string[] = []
  const transaction = {
    $executeRaw: async () => undefined,
    message: {
      create: async ({ data }: { data: { content: string; role: string } }) => {
        messages.push(data.content)
        return {
          content: data.content,
          createdAt: new Date('2026-09-08T18:47:00.000Z'),
          id: '00000000-0000-4000-8000-000000000007',
          role: 'assistant' as const,
        }
      },
    },
    messageBasisScope: { createMany: async () => undefined },
    run: { findFirst: async () => null },
    runBasisScope: { createMany: async () => undefined },
    runThreadPendingMessage: { findMany: async () => [] },
  }
  const deps = {
    prisma: {
      $executeRaw: async () => undefined,
      $transaction: async (work: (tx: typeof transaction) => Promise<unknown>) => work(transaction),
      agent: { update: async () => undefined },
      agentTodo: { updateMany: async () => undefined },
      message: transaction.message,
      run: {
        findUnique: async () => null,
        update: async ({ data }: { data: { status?: string } }) => { statuses.push(data.status ?? '') },
      },
      runCheckpoint: { deleteMany: async () => undefined },
      runToolEffect: { deleteMany: async () => undefined },
      task: { update: async ({ data }: { data: { status?: string } }) => { statuses.push(data.status ?? '') } },
      taskEvent: { create: async () => undefined },
    },
    realtimeTransport: { publishSse: async () => undefined, publishWs: async () => undefined },
  } as unknown as ExecutionDependencies
  const context = {
    agent: { agentKind: 'shared', effort: 'medium', executionMode: 'inference', id: IDS.agent, model: null, name: 'Planner', parentAgentId: null, provider: null, systemPrompt: null },
    boundAgentIds: [],
    channel: { id: IDS.channel, organizationId: IDS.organization, projectId: IDS.project, systemChannelType: null, teamId: IDS.team, visibility: 'public' },
    consumedSources: createConsumedSourceSink(),
    run: { createdAt: new Date(), id: IDS.run, replyPlacement: null, threadId: IDS.thread },
    task: { id: IDS.task },
  } satisfies RunContext
  const loopResult: LoopResult = {
    cacheReadTokens: 0,
    cancelled: false,
    effectiveTokensUsed: 0,
    exhaustedBudget: null,
    finalText: 'The model provider returned no final answer after a recovery attempt. Please try again; any completed work has been kept.',
    incompleteReason: 'empty_provider_response',
    invocations: [],
    iterations: 2,
    messages: [],
    toolCallsUsed: 1,
    toolMs: 0,
    totalCostCents: 0,
    totalTokensUsed: 0,
    wallclockMs: 0,
    woundDown: false,
  }
  const outcome = await handleRunLoopOutcome(
    deps,
    {
      actorContext: {
        actionContext: { requestId: 'request-1' },
        actor: { actorId: IDS.agent, actorType: 'user' },
        tenant: { organizationId: IDS.organization },
      } as never,
      agentId: IDS.agent as never,
      interactive: true,
      messageId: IDS.thread as never,
      runId: IDS.run as never,
      taskId: IDS.task as never,
      threadId: IDS.thread as never,
    },
    context,
    {
      documentStream: { finalizeOutstanding: async () => undefined } as never,
      handoffLocator: null,
      inference: {} as never,
      invocations: [],
      loopResult,
      planContext: null as never,
      prompt: 'Create the board',
      reacted: false,
      setup: {} as never,
      streamStarted: false,
    },
  )

  assert.equal(outcome, 'failed')
  assert.deepEqual(statuses, ['failed', 'failed'])
  assert.deepEqual(messages, [loopResult.finalText])
})
