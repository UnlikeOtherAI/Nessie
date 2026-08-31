import type { PrismaClient } from '@prisma/client'
import { applyReplyBookkeeping } from '@nessie/runtime'
import type { RunExecuteJobPayload, RunStatus, TaskStatus } from '@nessie/schemas'
import { parseAgentRunLimits } from '../run-budget.js'
import type { PgRealtimeTransport } from '@nessie/runtime'
import { createConsumedSourceSink } from './disclosure-basis.js'
import type { ReplyPlacement, RunContext } from './types.js'
import { clearWorking } from './working-marker.js'
import { releaseAgentTodosForTerminalRun } from '@nessie/workspace-admin'

export const updateTaskStatus = async (
  prisma: PrismaClient,
  taskId: string,
  status: TaskStatus,
): Promise<void> => {
  await prisma.task.update({
    where: { id: taskId },
    data: { status },
  })
}

export const updateRunStatus = async (
  prisma: PrismaClient,
  runId: string,
  status: RunStatus,
  // Supplied wherever the caller has one, so the cleared working marker
  // reaches open clients immediately. Its absence only delays the repaint to
  // the next refetch — the row is already gone either way.
  transport?: PgRealtimeTransport,
): Promise<void> => {
  const terminal =
    status === 'completed' || status === 'failed' || status === 'cancelled'
  await prisma.run.update({
    where: { id: runId },
    data: {
      finishedAt: terminal ? new Date() : null,
      startedAt: status === 'running' ? new Date() : undefined,
      status,
    },
  })

  // Clearing the "looking at this" reaction is fused to the terminal
  // transition rather than to any one terminal path, so completion, failure,
  // budget stop and cancellation all drop it without having to remember. A
  // crashed run is re-delivered by the queue and ends up here too, which is
  // what keeps the marker from outliving the work.
  if (!terminal) return
  // Wrapped: the run is already terminal in the database, and a decoration
  // must never be able to turn that into a thrown error.
  try {
    const run = await prisma.run.findUnique({
      select: { agentId: true, principalUserId: true, threadId: true, triggerMessageId: true },
      where: { id: runId },
    })
    await releaseAgentTodosForTerminalRun(prisma, runId)
    if (!run?.triggerMessageId) return
    await clearWorking(prisma, transport ?? null, {
      agentId: run.agentId,
      messageId: run.triggerMessageId,
      ...(run.principalUserId ? { onBehalfOfUserId: run.principalUserId } : {}),
      threadId: run.threadId,
    })
  } catch (error) {
    console.warn('[worker] could not clear working reaction for run', runId, error)
  }
}

// Atomic start claim: flips a still-claimable run to `running` in a single
// statement. A terminal run (completed/failed/cancelled) matches nothing and
// returns count === 0, so a re-driven job for a finished run is not resurrected.
// `running` is kept in the WHERE because the queue lock guarantees a single
// worker per job, so a re-entrant claim of the same in-flight run is benign.
export const claimRunForExecution = async (
  prisma: PrismaClient,
  runId: string,
): Promise<boolean> => {
  const { count } = await prisma.run.updateMany({
    where: { id: runId, status: { in: ['pending', 'running'] } },
    data: { status: 'running', startedAt: new Date() },
  })
  return count === 1
}

export const setAgentStatus = async (
  prisma: PrismaClient,
  agentId: string,
  status: 'idle' | 'thinking' | 'executing' | 'error',
): Promise<void> => {
  await prisma.agent.update({
    where: { id: agentId },
    data: { status },
  })
}

// Reply-thread placement (#233): after a run-authored message is created with
// `rootMessageId`, update the root's materialized reply metadata in the same
// unit of work and return it for realtime fan-out. A bookkeeping failure
// propagates exactly like a message-create failure — no silent fallback.
export const applyRunReplyBookkeeping = async (
  prisma: PrismaClient,
  context: RunContext,
  replyCreatedAt: Date,
): Promise<ReplyPlacement | undefined> => {
  const rootMessageId = context.replyRootMessageId
  if (!rootMessageId) return undefined
  const meta = await applyReplyBookkeeping(prisma, {
    rootMessageId,
    replyCreatedAt,
    authorId: context.agent.id,
  })
  return { rootMessageId, meta }
}

export const loadRunContext = async (
  prisma: PrismaClient,
  payload: RunExecuteJobPayload,
): Promise<RunContext | null> => {
  const run = await prisma.run.findUnique({
    where: { id: payload.runId },
    include: {
      agent: {
        select: {
          agentKind: true,
          effort: true,
          executionMode: true,
          id: true,
          model: true,
          name: true,
          parentAgentId: true,
          ownerUserId: true,
          provider: true,
          // Optional explicit per-run caps; absent keys fall through to the
          // deployment backstop (see run-budget.ts).
          runLimits: true,
          systemPrompt: true,
          visibility: true,
        },
      },
      thread: {
        select: {
          id: true,
          channel: {
            select: {
              id: true,
              organizationId: true,
              projectId: true,
              teamId: true,
              systemChannelType: true,
              dmKey: true,
            },
          },
        },
      },
      tasks: {
        where: { id: payload.taskId },
        select: { id: true },
        take: 1,
      },
      trigger: { select: { agentId: true, targetThreadId: true } },
    },
  })

  const task = run?.tasks[0]
  if (!run || !task) {
    return null
  }

  // One indexed lookup, cached on the context. The live stream gate calls the
  // disclosure predicate for every delta and must never perform IO itself.
  const boundAgents = await prisma.agentBinding.findMany({
    where: { channelId: run.thread.channel.id },
    select: { agentId: true },
  })

  return {
    agent: { ...run.agent, runLimits: parseAgentRunLimits(run.agent.runLimits) },
    boundAgentIds: boundAgents.map((binding) => binding.agentId),
    channel: run.thread.channel,
    consumedSources: createConsumedSourceSink(),
    run: {
      id: run.id,
      principalUserId: run.principalUserId,
      threadId: run.thread.id,
      createdAt: run.createdAt,
      replyPlacement: run.replyPlacement,
      trigger: run.trigger,
    },
    task,
  }
}
