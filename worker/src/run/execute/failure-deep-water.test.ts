import assert from 'node:assert/strict'
import test from 'node:test'

import { handleRunExecutionFailure } from './failure.js'
import type { ExecutionDependencies, RunContext } from './types.js'
import { createConsumedSourceSink } from './disclosure-basis.js'

/**
 * A DeepWater wake is unattended — nobody is at the keyboard — but it is owed:
 * the person who asked for the research is waiting for the agent's answer in
 * that thread. So its failure is announced there, as a peer delegation's is,
 * while an ordinary unattended fire stays quiet (Water plan amendments N4).
 */

const ID = {
  agent: '00000000-0000-4000-8000-000000000101',
  channel: '00000000-0000-4000-8000-000000000102',
  organization: '00000000-0000-4000-8000-000000000103',
  run: '00000000-0000-4000-8000-000000000104',
  task: '00000000-0000-4000-8000-000000000105',
  project: '00000000-0000-4000-8000-000000000106',
  team: '00000000-0000-4000-8000-000000000107',
  thread: '00000000-0000-4000-8000-000000000108',
  card: '00000000-0000-4000-8000-000000000109',
}

test('a DeepWater wake that fails tells the thread; an ordinary unattended fire does not', async () => {
  const messages: Array<{ content: string; role: string; rootMessageId: string | null }> = []
  const create = async ({ data }: { data: { content: string; role: string; rootMessageId?: string } }) => {
    messages.push({ ...data, rootMessageId: data.rootMessageId ?? null })
    return {
      content: data.content,
      createdAt: new Date('2026-09-23T10:00:00.000Z'),
      id: '00000000-0000-4000-8000-000000000110',
      role: 'assistant' as const,
    }
  }
  const transaction = {
    $executeRaw: async () => undefined,
    message: { create },
    messageBasisScope: { createMany: async () => undefined },
    run: { findFirst: async () => null },
    runBasisScope: { createMany: async () => undefined },
    runThreadPendingMessage: { findMany: async () => [] },
  }
  const deps = {
    prisma: {
      // The reply's root bookkeeping updates the card it answers under.
      $queryRaw: async () => [{ reply_count: 1, last_reply_at: new Date(), reply_participant_ids: [] }],
      $transaction: async (work: (tx: typeof transaction) => Promise<unknown>) => work(transaction),
      agent: { update: async () => undefined },
      message: { create },
      run: { update: async () => undefined },
      task: { update: async () => undefined },
      taskEvent: { create: async () => undefined },
    },
    realtimeTransport: { publishSse: async () => undefined, publishWs: async () => undefined },
  } as unknown as ExecutionDependencies
  const context = {
    agent: {
      agentKind: 'shared',
      effort: 'medium',
      executionMode: 'inference',
      id: ID.agent,
      name: 'Analyst',
      parentAgentId: null,
      model: null,
      provider: null,
      systemPrompt: null,
    },
    boundAgentIds: [],
    channel: {
      id: ID.channel,
      organizationId: ID.organization,
      projectId: ID.project,
      systemChannelType: null,
      visibility: 'public',
      teamId: ID.team,
    },
    consumedSources: createConsumedSourceSink(),
    run: { createdAt: new Date(), id: ID.run, replyPlacement: 'channel', threadId: ID.thread },
    // The wake's kickoff sits under the research card, so the failure lands there too.
    replyRootMessageId: ID.card,
    task: { id: ID.task },
  } satisfies RunContext
  const fail = (purpose: string | undefined, runId: string) => handleRunExecutionFailure(
    deps,
    {
      actorContext: { actionContext: purpose ? { purpose } : {} } as never,
      agentId: ID.agent as never,
      messageId: '00000000-0000-4000-8000-000000000111',
      runId: runId as never,
      taskId: ID.task as never,
      threadId: ID.thread as never,
    },
    context,
    { error: new Error('Missing API key for provider kimi'), planContext: null, streamStarted: false },
  )

  await fail('deep_water.delivery', ID.run)
  assert.equal(messages.length, 1)
  assert.equal(messages[0]?.role, 'assistant')
  assert.equal(messages[0]?.rootMessageId, ID.card)

  await fail(undefined, '00000000-0000-4000-8000-000000000112')
  assert.equal(messages.length, 1, 'an ordinary unattended fire stays quiet')
})
