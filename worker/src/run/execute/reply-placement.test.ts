import assert from 'node:assert/strict'
import test from 'node:test'

import type { RunExecuteJobPayload } from '@nessie/schemas'
import { terminalizeBudgetBlockedRun } from './budget-gate.js'
import { finalizeCancelledRun } from './cancel-stop.js'
import { completeRunExecution } from './completion.js'
import { handleRunExecutionFailure } from './failure.js'
import { loadConversation } from './prompt.js'
import { resolveReplyRootMessageId } from './run-job.js'
import type { ExecutionDependencies, RunContext } from './types.js'

const AGENT_ID = '00000000-0000-0000-0000-0000000000a1'
const CHANNEL_ID = '00000000-0000-0000-0000-0000000000b1'
const ORGANIZATION_ID = '00000000-0000-0000-0000-0000000000c1'
const RUN_ID = '00000000-0000-0000-0000-0000000000d1'
const THREAD_ID = '00000000-0000-0000-0000-0000000000e1'
const TASK_ID = '00000000-0000-0000-0000-0000000000f1'
const TRIGGER_MESSAGE_ID = '00000000-0000-0000-0000-000000000011'
const ROOT_MESSAGE_ID = '00000000-0000-0000-0000-000000000022'
const REPLY_MESSAGE_ID = '00000000-0000-0000-0000-000000000033'
const USER_ID = '00000000-0000-0000-0000-000000000044'
const TEAM_ID = '00000000-0000-0000-0000-000000000055'
const PLAN_ID = '00000000-0000-0000-0000-000000000066'
const PLAN_STEP_ID = '00000000-0000-0000-0000-000000000077'

const REPLY_CREATED_AT = new Date('2026-07-24T10:00:00.000Z')
const LAST_REPLY_AT = new Date('2026-07-24T10:00:01.000Z')

const makeContext = (replyRootMessageId?: string): RunContext => ({
  agent: {
    agentKind: 'shared',
    effort: 'medium',
    executionMode: 'inference',
    id: AGENT_ID,
    model: null,
    name: 'Aria',
    parentAgentId: null,
    provider: null,
    systemPrompt: null,
  },
  channel: { id: CHANNEL_ID, organizationId: ORGANIZATION_ID, systemChannelType: null },
  run: { id: RUN_ID, threadId: THREAD_ID, createdAt: new Date('2026-07-24T09:00:00Z') },
  task: { id: TASK_ID },
  ...(replyRootMessageId ? { replyRootMessageId } : {}),
})

const makePayload = (): RunExecuteJobPayload =>
  ({
    actorContext: {
      actor: { actorId: USER_ID, actorType: 'user' },
      actionContext: { channelId: CHANNEL_ID, taskId: TASK_ID, teamId: TEAM_ID, threadId: THREAD_ID },
      tenant: { organizationId: ORGANIZATION_ID, teamId: TEAM_ID },
    },
    agentId: AGENT_ID,
    messageId: TRIGGER_MESSAGE_ID,
    runId: RUN_ID,
    taskId: TASK_ID,
    threadId: THREAD_ID,
  }) as unknown as RunExecuteJobPayload

type MessageCreateArgs = { data: Record<string, unknown> }
type WsCall = { data: Record<string, unknown>; event: string }
type SseCall = { data: Record<string, unknown>; event: string }

// Stubbed ExecutionDependencies for the run-message creation sites: records
// message.create args, raw bookkeeping calls, and realtime events.
const makeDeps = () => {
  const messageCreates: MessageCreateArgs[] = []
  const queryRawCalls: unknown[] = []
  const ws: WsCall[] = []
  const sse: SseCall[] = []
  const prisma = {
    $executeRaw: async () => 1,
    $queryRaw: async (...args: unknown[]) => {
      queryRawCalls.push(args)
      return [
        {
          reply_count: 3,
          last_reply_at: LAST_REPLY_AT,
          reply_participant_ids: [AGENT_ID],
        },
      ]
    },
    agent: { update: async () => ({}) },
    message: {
      create: async (args: MessageCreateArgs) => {
        messageCreates.push(args)
        return {
          content: args.data.content,
          createdAt: REPLY_CREATED_AT,
          id: REPLY_MESSAGE_ID,
          role: args.data.role,
        }
      },
    },
    plan: { update: async () => ({}) },
    planStep: { count: async () => 0, update: async () => ({}) },
    run: { update: async () => ({}) },
    task: { update: async () => ({}) },
    taskEvent: { create: async () => ({}) },
  }
  const realtimeTransport = {
    publishSse: async (_threadId: string, event: string, data: Record<string, unknown>) => {
      sse.push({ data, event })
    },
    publishWs: async (_scopes: unknown, input: WsCall) => {
      ws.push(input)
    },
  }
  const deps = { prisma, realtimeTransport } as unknown as ExecutionDependencies
  return { deps, messageCreates, queryRawCalls, sse, ws }
}

const wsEvents = (ws: WsCall[], event: string): WsCall[] =>
  ws.filter((call) => call.event === event)

test('resolveReplyRootMessageId: a root trigger replies into itself', () => {
  assert.equal(
    resolveReplyRootMessageId({ id: TRIGGER_MESSAGE_ID, rootMessageId: null }, null),
    TRIGGER_MESSAGE_ID,
  )
})

test('resolveReplyRootMessageId: a reply trigger attaches to the same root (one level)', () => {
  assert.equal(
    resolveReplyRootMessageId({ id: TRIGGER_MESSAGE_ID, rootMessageId: ROOT_MESSAGE_ID }, null),
    ROOT_MESSAGE_ID,
  )
})

test('resolveReplyRootMessageId: a DeepWater handoff run stays top-level', () => {
  const handoffLocator = {
    messageId: TRIGGER_MESSAGE_ID,
    organizationId: ORGANIZATION_ID,
    runId: RUN_ID,
    teamId: TEAM_ID,
    threadId: THREAD_ID,
  }
  assert.equal(
    resolveReplyRootMessageId({ id: TRIGGER_MESSAGE_ID, rootMessageId: null }, handoffLocator),
    undefined,
  )
  assert.equal(
    resolveReplyRootMessageId(
      { id: TRIGGER_MESSAGE_ID, rootMessageId: ROOT_MESSAGE_ID },
      handoffLocator,
    ),
    undefined,
  )
})

test('completeRunExecution attaches rootMessageId, bookkeeping, and reply events', async () => {
  const { deps, messageCreates, queryRawCalls, sse, ws } = makeDeps()
  const context = makeContext(ROOT_MESSAGE_ID)

  await completeRunExecution(deps, makePayload(), context, {
    planId: PLAN_ID,
    rootStepId: PLAN_STEP_ID,
  }, {
    invocations: [],
    iterations: 1,
    memories: [],
    responseText: 'Done — deployed the fix.',
    toolCallsUsed: 0,
  })

  assert.equal(messageCreates.length, 1)
  assert.equal(messageCreates[0]!.data.rootMessageId, ROOT_MESSAGE_ID)
  assert.equal(messageCreates[0]!.data.role, 'assistant')

  // Bookkeeping ran against the root with the reply's creation timestamp.
  assert.equal(queryRawCalls.length, 1)

  const replies = wsEvents(ws, 'message.reply')
  assert.equal(replies.length, 1)
  assert.equal(replies[0]!.data.messageId, REPLY_MESSAGE_ID)
  assert.equal(replies[0]!.data.rootMessageId, ROOT_MESSAGE_ID)
  assert.equal(replies[0]!.data.agentId, AGENT_ID)
  assert.equal(wsEvents(ws, 'message.new').length, 0)

  const metas = wsEvents(ws, 'message.reply.meta')
  assert.equal(metas.length, 1)
  assert.deepEqual(metas[0]!.data, {
    channelId: CHANNEL_ID,
    threadId: THREAD_ID,
    rootMessageId: ROOT_MESSAGE_ID,
    replyCount: 3,
    lastReplyAt: LAST_REPLY_AT.toISOString(),
    replyParticipantIds: [AGENT_ID],
  })

  const streamDone = sse.find((call) => call.event === 'stream.done')
  assert.ok(streamDone)
  assert.equal(streamDone.data.rootMessageId, ROOT_MESSAGE_ID)
})

test('completeRunExecution without a reply root stays byte-identical (top-level)', async () => {
  const { deps, messageCreates, queryRawCalls, sse, ws } = makeDeps()
  const context = makeContext()

  await completeRunExecution(deps, makePayload(), context, {
    planId: PLAN_ID,
    rootStepId: PLAN_STEP_ID,
  }, {
    invocations: [],
    iterations: 1,
    memories: [],
    responseText: 'Done.',
    toolCallsUsed: 0,
  })

  assert.equal(messageCreates.length, 1)
  assert.equal('rootMessageId' in messageCreates[0]!.data, false)
  assert.equal(queryRawCalls.length, 0)
  assert.equal(wsEvents(ws, 'message.new').length, 1)
  assert.equal(wsEvents(ws, 'message.reply').length, 0)
  assert.equal(wsEvents(ws, 'message.reply.meta').length, 0)
  const streamDone = sse.find((call) => call.event === 'stream.done')
  assert.ok(streamDone)
  assert.equal('rootMessageId' in streamDone.data, false)
})

test('terminalizeBudgetBlockedRun attaches rootMessageId and emits reply events', async () => {
  const { deps, messageCreates, queryRawCalls, ws } = makeDeps()
  const context = makeContext(ROOT_MESSAGE_ID)

  await terminalizeBudgetBlockedRun(deps, context, 'budget exceeded', {})

  assert.equal(messageCreates.length, 1)
  assert.equal(messageCreates[0]!.data.rootMessageId, ROOT_MESSAGE_ID)
  assert.equal(queryRawCalls.length, 1)
  assert.equal(wsEvents(ws, 'message.reply').length, 1)
  assert.equal(wsEvents(ws, 'message.reply.meta').length, 1)
  assert.equal(wsEvents(ws, 'message.new').length, 0)
})

test('finalizeCancelledRun attaches rootMessageId and emits reply events', async () => {
  const { deps, messageCreates, queryRawCalls, ws } = makeDeps()
  const context = makeContext(ROOT_MESSAGE_ID)

  await finalizeCancelledRun(deps, makePayload(), context, null, {
    hadPartialText: false,
    invocations: [],
    notice: 'cancelled',
    responseText: '',
  })

  assert.equal(messageCreates.length, 1)
  assert.equal(messageCreates[0]!.data.rootMessageId, ROOT_MESSAGE_ID)
  assert.equal(queryRawCalls.length, 1)
  assert.equal(wsEvents(ws, 'message.reply').length, 1)
  assert.equal(wsEvents(ws, 'message.reply.meta').length, 1)
})

test('handleRunExecutionFailure attaches rootMessageId and emits reply events', async () => {
  const { deps, messageCreates, queryRawCalls, ws } = makeDeps()
  const context = makeContext(ROOT_MESSAGE_ID)

  await handleRunExecutionFailure(deps, makePayload(), context, {
    error: new Error('boom'),
    planContext: null,
    streamStarted: true,
  })

  assert.equal(messageCreates.length, 1)
  assert.equal(messageCreates[0]!.data.rootMessageId, ROOT_MESSAGE_ID)
  assert.equal(queryRawCalls.length, 1)
  assert.equal(wsEvents(ws, 'message.reply').length, 1)
  assert.equal(wsEvents(ws, 'message.reply.meta').length, 1)
})

test('loadConversation scopes to the reply thread when rootMessageId is set', async () => {
  const wheres: unknown[] = []
  const prisma = {
    message: {
      findMany: async (args: { where: unknown }) => {
        wheres.push(args.where)
        return []
      },
    },
  } as unknown as Parameters<typeof loadConversation>[0]

  await loadConversation(prisma, THREAD_ID, ROOT_MESSAGE_ID)
  assert.deepEqual(wheres[0], {
    threadId: THREAD_ID,
    role: { not: 'system' },
    OR: [{ id: ROOT_MESSAGE_ID }, { rootMessageId: ROOT_MESSAGE_ID }],
  })

  await loadConversation(prisma, THREAD_ID)
  assert.deepEqual(wheres[1], { threadId: THREAD_ID, role: { not: 'system' } })
})
