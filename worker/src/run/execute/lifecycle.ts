import type { PrismaClient } from '@prisma/client'
import { applyReplyBookkeeping } from '@nessie/runtime'
import type { RunExecuteJobPayload, RunStatus, TaskStatus } from '@nessie/schemas'
import type { ReplyPlacement, RunContext } from './types.js'

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
): Promise<void> => {
  await prisma.run.update({
    where: { id: runId },
    data: {
      finishedAt:
        status === 'completed' || status === 'failed' || status === 'cancelled'
          ? new Date()
          : null,
      startedAt: status === 'running' ? new Date() : undefined,
      status,
    },
  })
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
          provider: true,
          systemPrompt: true,
        },
      },
      thread: {
        select: {
          id: true,
          channel: {
            select: {
              id: true,
              organizationId: true,
              systemChannelType: true,
            },
          },
        },
      },
      tasks: {
        where: { id: payload.taskId },
        select: { id: true },
        take: 1,
      },
    },
  })

  const task = run?.tasks[0]
  if (!run || !task) {
    return null
  }

  return {
    agent: run.agent,
    channel: run.thread.channel,
    run: {
      id: run.id,
      threadId: run.thread.id,
      createdAt: run.createdAt,
      replyPlacement: run.replyPlacement,
    },
    task,
  }
}
