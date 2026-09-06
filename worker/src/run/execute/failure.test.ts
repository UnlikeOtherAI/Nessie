import assert from 'node:assert/strict'
import test from 'node:test'

import { ProviderHttpError } from '@nessie/runtime'
import { handleRunExecutionFailure } from './failure.js'
import { PrivateAgentPlacementError } from './private-agent-placement.js'
import type { ExecutionDependencies, RunContext } from './types.js'
import { createConsumedSourceSink } from './disclosure-basis.js'

const ID = {
  agent: '00000000-0000-4000-8000-000000000001',
  channel: '00000000-0000-4000-8000-000000000002',
  organization: '00000000-0000-4000-8000-000000000003',
  run: '00000000-0000-4000-8000-000000000004',
  task: '00000000-0000-4000-8000-000000000005',
  project: '00000000-0000-4000-8000-00000000000b',
  team: '00000000-0000-4000-8000-00000000000c',
  thread: '00000000-0000-4000-8000-000000000006',
}

test('an interactive run tells the person waiting that Ledger credits are exhausted', async () => {
  const messages: Array<{ content: string; role: string }> = []
  const streamEvents: string[] = []
  // A real `$transaction` hands the callback a client carrying every model, so
  // the stub must too: the message chokepoint writes the row and its basis rows
  // inside one, and a transaction client missing `message` made the write throw
  // rather than fail an assertion.
  const transaction = {
    $executeRaw: async () => undefined,
    message: {
      create: async ({ data }: { data: { content: string; role: string } }) => {
        messages.push(data)
        return {
          content: data.content,
          createdAt: new Date('2026-08-04T20:00:00.000Z'),
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
      $transaction: async (work: (tx: typeof transaction) => Promise<unknown>) => work(transaction),
      agent: { update: async () => undefined },
      message: {
        create: async ({ data }: { data: { content: string; role: string } }) => {
          messages.push(data)
          return {
            content: data.content,
            createdAt: new Date('2026-08-04T20:00:00.000Z'),
            id: '00000000-0000-4000-8000-000000000007',
            role: 'assistant' as const,
          }
        },
      },
      run: { update: async () => undefined },
      task: { update: async () => undefined },
      taskEvent: { create: async () => undefined },
    },
    realtimeTransport: {
      publishSse: async (_threadId: string, event: string) => {
        streamEvents.push(event)
      },
      publishWs: async () => undefined,
    },
  } as unknown as ExecutionDependencies
  const context = {
    agent: {
      agentKind: 'personal_assistant',
      effort: 'medium',
      executionMode: 'inference',
      id: ID.agent,
      name: 'Personal Assistant',
      parentAgentId: null,
      model: null,
      provider: null,
      systemPrompt: null,
    },
    boundAgentIds: [],
    channel: {
      id: ID.channel,
      organizationId: ID.organization,
      projectId: '00000000-0000-0000-0000-0000000000d1',
      teamId: '00000000-0000-0000-0000-0000000000d2',
      systemChannelType: 'personal_assistant',
    },
    consumedSources: createConsumedSourceSink(),
    run: { createdAt: new Date(), id: ID.run, replyPlacement: null, threadId: ID.thread },
    task: { id: ID.task },
  } satisfies RunContext

  await handleRunExecutionFailure(
    deps,
    {
      actorContext: {} as never,
      agentId: ID.agent as never,
      // Somebody is waiting on this turn, so the failure has an audience.
      interactive: true,
      messageId: '00000000-0000-4000-8000-000000000008',
      runId: ID.run as never,
      taskId: ID.task as never,
      threadId: ID.thread as never,
    },
    context,
    {
      error: new ProviderHttpError(
        'openai-compatible chat request failed with HTTP 402',
        {
          creditRefusal: 'ledger',
          providerCode: 'budget_exceeded',
          statusCode: 402,
        },
      ),
      planContext: null,
      streamStarted: false,
    },
  )

  assert.deepEqual(messages, [
    {
      agentId: ID.agent,
      content:
        'Your team has no AI credits remaining. Ask a billing manager to add credits or update billing in Credits & billing (/tokens), then try again.',
      role: 'assistant',
      threadId: ID.thread,
    },
  ])
  assert.deepEqual(streamEvents, [])
})

test('an unattended run fails quietly — no message into a room that did not ask', async () => {
  const messages: Array<{ content: string; role: string }> = []
  // A real `$transaction` hands the callback a client carrying every model, so
  // the stub must too: the message chokepoint writes the row and its basis rows
  // inside one, and a transaction client missing `message` made the write throw
  // rather than fail an assertion.
  const transaction = {
    $executeRaw: async () => undefined,
    message: {
      create: async ({ data }: { data: { content: string; role: string } }) => {
        messages.push(data)
        return {
          content: data.content,
          createdAt: new Date('2026-08-04T20:00:00.000Z'),
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
      $transaction: async (work: (tx: typeof transaction) => Promise<unknown>) => work(transaction),
      agent: { update: async () => undefined },
      message: {
        create: async ({ data }: { data: { content: string; role: string } }) => {
          messages.push(data)
          return {
            content: data.content,
            createdAt: new Date('2026-08-11T20:00:00.000Z'),
            id: '00000000-0000-4000-8000-000000000009',
            role: 'assistant' as const,
          }
        },
      },
      run: { update: async () => undefined },
      task: { update: async () => undefined },
      taskEvent: { create: async () => undefined },
    },
    realtimeTransport: {
      publishSse: async () => undefined,
      publishWs: async () => undefined,
    },
  } as unknown as ExecutionDependencies
  const context = {
    agent: {
      agentKind: 'shared',
      effort: 'medium',
      executionMode: 'inference',
      id: ID.agent,
      name: 'Hardware Watch',
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
      teamId: ID.team,
    },
    consumedSources: createConsumedSourceSink(),
    run: { createdAt: new Date(), id: ID.run, replyPlacement: null, threadId: ID.thread },
    task: { id: ID.task },
  } satisfies RunContext

  await handleRunExecutionFailure(
    deps,
    {
      actorContext: {} as never,
      agentId: ID.agent as never,
      // No `interactive` flag: a scheduled sweep. Nobody is waiting, and
      // repeating the same apology every 15 minutes would bury the findings
      // the channel exists for.
      messageId: '00000000-0000-4000-8000-00000000000a',
      runId: ID.run as never,
      taskId: ID.task as never,
      threadId: ID.thread as never,
    },
    context,
    {
      error: new Error('Missing API key for provider kimi'),
      planContext: null,
      streamStarted: false,
    },
  )

  assert.deepEqual(messages, [])
})

test('an invalid private placement fails without speaking into the shared destination', async () => {
  const messages: unknown[] = []
  const transaction = {
    $executeRaw: async () => undefined,
    message: { create: async (input: unknown) => { messages.push(input); return {} } },
    messageBasisScope: { createMany: async () => undefined },
    run: { findFirst: async () => null },
    runBasisScope: { createMany: async () => undefined },
    runThreadPendingMessage: { findMany: async () => [] },
  }
  const deps = {
    prisma: {
      $transaction: async (work: (tx: typeof transaction) => Promise<unknown>) => work(transaction),
      agent: { update: async () => undefined },
      run: { update: async () => undefined },
      task: { update: async () => undefined },
      taskEvent: { create: async () => undefined },
    },
    realtimeTransport: {
      publishSse: async () => undefined,
      publishWs: async () => undefined,
    },
  } as unknown as ExecutionDependencies
  const context = {
    agent: {
      agentKind: 'shared',
      effort: 'medium',
      executionMode: 'inference',
      id: ID.agent,
      name: 'Private agent',
      ownerUserId: '00000000-0000-4000-8000-000000000010',
      parentAgentId: null,
      model: null,
      provider: null,
      systemPrompt: null,
      visibility: 'private',
    },
    boundAgentIds: [],
    channel: {
      dmKey: null,
      id: ID.channel,
      organizationId: ID.organization,
      projectId: ID.project,
      systemChannelType: null,
      teamId: ID.team,
    },
    consumedSources: createConsumedSourceSink(),
    run: { createdAt: new Date(), id: ID.run, replyPlacement: null, threadId: ID.thread },
    task: { id: ID.task },
  } satisfies RunContext

  await handleRunExecutionFailure(
    deps,
    {
      actorContext: {} as never,
      agentId: ID.agent as never,
      interactive: true,
      messageId: '00000000-0000-4000-8000-000000000011',
      runId: ID.run as never,
      taskId: ID.task as never,
      threadId: ID.thread as never,
    },
    context,
    {
      error: new PrivateAgentPlacementError(),
      planContext: null,
      streamStarted: false,
    },
  )

  assert.deepEqual(messages, [])
})

test('an interactive failure is written to the worker log the message points at', async () => {
  // The reply tells a team owner to check the worker logs. Before this, the
  // only console line here was in the branch an interactive run never takes,
  // so the one person who could act on the failure was sent somewhere empty —
  // and `unknown`, the classifier's fallthrough, says nothing about the cause.
  const logged: unknown[][] = []
  const originalError = console.error
  console.error = (...args: unknown[]) => { logged.push(args) }

  const transaction = {
    $executeRaw: async () => undefined,
    message: {
      create: async ({ data }: { data: { content: string; role: string } }) => ({
        content: data.content,
        createdAt: new Date('2026-09-05T15:53:00.000Z'),
        id: '00000000-0000-4000-8000-000000000007',
        role: 'assistant' as const,
      }),
    },
    messageBasisScope: { createMany: async () => undefined },
    run: { findFirst: async () => null },
    runBasisScope: { createMany: async () => undefined },
    runThreadPendingMessage: { findMany: async () => [] },
  }
  const deps = {
    prisma: {
      $transaction: async (work: (tx: typeof transaction) => Promise<unknown>) => work(transaction),
      agent: { update: async () => undefined },
      run: { update: async () => undefined },
      task: { update: async () => undefined },
      taskEvent: { create: async () => undefined },
    },
    realtimeTransport: {
      publishSse: async () => undefined,
      publishWs: async () => undefined,
    },
  } as unknown as ExecutionDependencies
  const context = {
    agent: {
      agentKind: 'shared',
      effort: 'medium',
      executionMode: 'inference',
      id: ID.agent,
      model: null,
      name: 'Dashboard Designer',
      parentAgentId: null,
      provider: null,
      systemPrompt: null,
      systemSlug: 'dashboard-designer',
    },
    boundAgentIds: [],
    channel: {
      id: ID.channel,
      organizationId: ID.organization,
      projectId: ID.project,
      systemChannelType: 'system_agent',
      teamId: ID.team,
    },
    consumedSources: createConsumedSourceSink(),
    run: { createdAt: new Date(), id: ID.run, replyPlacement: null, threadId: ID.thread },
    task: { id: ID.task },
  } satisfies RunContext

  try {
    await handleRunExecutionFailure(
      deps,
      {
        actorContext: {} as never,
        agentId: ID.agent as never,
        interactive: true,
        messageId: '00000000-0000-4000-8000-000000000008',
        runId: ID.run as never,
        taskId: ID.task as never,
        threadId: ID.thread as never,
      },
      context,
      {
        error: new Error('Cannot read properties of undefined (reading "id")'),
        planContext: null,
        streamStarted: false,
      },
    )
  } finally {
    console.error = originalError
  }

  const failureLine = logged.find((args) =>
    typeof args[0] === 'string' && args[0].includes(`run ${ID.run} failed`))
  assert.ok(failureLine, 'the failure never reached the worker log')
  // The classified bucket, so an operator can tell "no credits" from "no idea".
  assert.match(failureLine[0] as string, /\(unknown\)/)
  // Which agent, so a tier-wide fault is distinguishable from one specialist.
  assert.deepEqual(failureLine[1], {
    agentId: ID.agent,
    systemSlug: 'dashboard-designer',
    threadId: ID.thread,
  })
  // And the error itself — the only description of the cause that exists.
  assert.match((failureLine[2] as Error).message, /Cannot read properties of undefined/)
})
