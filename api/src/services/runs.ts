import type { PrismaClient } from '@prisma/client'
import {
  parseAgentId,
  parseChannelId,
  parseRunId,
  parseTaskId,
  parseThreadId,
  parseUserId,
  withActionContext,
  type AuthorizedActionContext,
  type RunStatus,
} from '@nessie/schemas'

import { enqueueRunExecution } from '../queue/pgqueue.js'
import { isThreadRunSlotBusy } from '@nessie/db'
import { buildAgentVisibilityWhere } from '@nessie/workspace-admin'
import { expirePendingToolApprovalsForRun } from './approval-resume.js'
import {
  ACTIVE_RUN_STATUSES,
  RESTARTABLE_RUN_STATUSES,
  handoffProductSlug,
  loadRunForOrg,
} from './run-access.js'

export type ActiveRunSummary = {
  id: string
  agentId: string
  agentName: string
  threadId: string
  channelId: string
  status: RunStatus
  startedAt: string | null
  createdAt: string
  cancelRequested: boolean
  toolCallCount: number
}

export const listActiveRuns = async (
  prisma: PrismaClient,
  organizationId: string,
  userId: string,
): Promise<ActiveRunSummary[]> => {
  const runs = await prisma.run.findMany({
    where: {
      agent: buildAgentVisibilityWhere({ organizationId, userId }),
      status: { in: ACTIVE_RUN_STATUSES },
      thread: { channel: { organizationId } },
    },
    orderBy: { createdAt: 'desc' },
    take: 100,
    select: {
      id: true,
      agentId: true,
      status: true,
      startedAt: true,
      createdAt: true,
      cancelRequestedAt: true,
      threadId: true,
      thread: { select: { channelId: true } },
      agent: { select: { name: true } },
      _count: { select: { toolCalls: true } },
    },
  })

  return runs.map((run) => ({
    id: run.id,
    agentId: run.agentId,
    agentName: run.agent.name,
    threadId: run.threadId,
    channelId: run.thread.channelId,
    status: run.status,
    startedAt: run.startedAt?.toISOString() ?? null,
    createdAt: run.createdAt.toISOString(),
    cancelRequested: run.cancelRequestedAt != null,
    toolCallCount: run._count.toolCalls,
  }))
}

export type RestartableRunSummary = {
  id: string
  agentId: string
  agentName: string
  threadId: string
  channelId: string
  status: RunStatus
  finishedAt: string | null
  createdAt: string
  toolCallCount: number
  // The run's own unconsumed `RunCheckpoint`, when it stopped at a policy
  // ceiling with durable work state. Present = the admin panel offers Continue
  // as the primary affordance; null = restart only.
  checkpointId: string | null
}

// Recently-ended runs that can be restarted (failed or cancelled), so the UI can
// offer the "restart" control next to the live-run list. Handoff-bound runs are
// excluded — they are never restartable through this path.
export const listRestartableRuns = async (
  prisma: PrismaClient,
  organizationId: string,
  userId: string,
): Promise<RestartableRunSummary[]> => {
  const runs = await prisma.run.findMany({
    where: {
      agent: buildAgentVisibilityWhere({ organizationId, userId }),
      status: { in: RESTARTABLE_RUN_STATUSES },
      thread: { channel: { organizationId } },
      triggerMessageId: { not: null },
    },
    orderBy: { finishedAt: 'desc' },
    take: 20,
    select: {
      id: true,
      agentId: true,
      status: true,
      finishedAt: true,
      createdAt: true,
      threadId: true,
      thread: { select: { channelId: true } },
      agent: { select: { name: true } },
      triggerMessage: { select: { metadata: true } },
      checkpoint: { select: { id: true, consumedByRunId: true } },
      _count: { select: { toolCalls: true } },
    },
  })

  return runs
    .filter((run) => handoffProductSlug(run.triggerMessage?.metadata ?? null) === null)
    .map((run) => ({
      id: run.id,
      agentId: run.agentId,
      agentName: run.agent.name,
      threadId: run.threadId,
      channelId: run.thread.channelId,
      status: run.status,
      finishedAt: run.finishedAt?.toISOString() ?? null,
      createdAt: run.createdAt.toISOString(),
      toolCallCount: run._count.toolCalls,
      checkpointId:
        run.checkpoint && run.checkpoint.consumedByRunId === null
          ? run.checkpoint.id
          : null,
    }))
}

export type CancelRunResult =
  | { kind: 'not_found' }
  | { kind: 'handoff_managed'; productSlug: string }
  | { kind: 'already_terminal'; status: RunStatus }
  // A queued or approval-suspended run: flipped straight to `cancelled`; it never
  // executes. `channelId`/`agentId` let the route publish realtime.
  | { kind: 'cancelled'; agentId: string; channelId: string }
  // A running run: the cooperative flag is set; the worker terminalizes it.
  | { kind: 'cancel_requested'; agentId: string; channelId: string }

export const requestRunCancellation = async (
  prisma: PrismaClient,
  input: { organizationId: string; runId: string; cancelledByUserId: string },
): Promise<CancelRunResult> => {
  const run = await loadRunForOrg(prisma, input.runId, input.organizationId)
  if (!run) return { kind: 'not_found' }

  const productSlug = handoffProductSlug(run.triggerMessageMetadata)
  if (productSlug) return { kind: 'handoff_managed', productSlug }

  const now = new Date()

  // Queued or approval-suspended: cancel immediately in one atomic statement so
  // the (never-executed) run is skipped by the worker's terminal-state guard.
  const immediate = await prisma.run.updateMany({
    where: { id: run.id, status: { in: ['pending', 'waiting_approval'] } },
    data: { status: 'cancelled', finishedAt: now, cancelRequestedAt: now, cancelRequestedByUserId: input.cancelledByUserId },
  })
  if (immediate.count === 1) {
    await expirePendingToolApprovalsForRun(prisma, run.id)
    await prisma.task.updateMany({ where: { runId: run.id }, data: { status: 'cancelled' } })
    const task = await prisma.task.findFirst({ where: { runId: run.id }, select: { id: true } })
    if (task) {
      await prisma.taskEvent.create({
        data: {
          eventType: 'run.cancelled',
          payload: {
            cancelRequestedAt: now.toISOString(),
            cancelledByUserId: input.cancelledByUserId,
            hadPartialText: false,
            stage: 'queued',
          },
          taskId: task.id,
        },
      })
    }
    return { kind: 'cancelled', agentId: run.agentId, channelId: run.channelId }
  }

  // Running: set the cooperative cancel flag; the agentic loop observes it and
  // terminalizes the run (records the `run.cancelled` TaskEvent + notice).
  const running = await prisma.run.updateMany({
    where: { id: run.id, status: 'running' },
    data: { cancelRequestedAt: now, cancelRequestedByUserId: input.cancelledByUserId },
  })
  if (running.count === 1) {
    return { kind: 'cancel_requested', agentId: run.agentId, channelId: run.channelId }
  }

  // Neither branch matched: the run reached a terminal state between the load
  // and the updates.
  const fresh = await prisma.run.findUnique({ where: { id: run.id }, select: { status: true } })
  return { kind: 'already_terminal', status: fresh?.status ?? run.status }
}

export type RestartRunResult =
  | { kind: 'not_found' }
  | { kind: 'handoff_managed'; productSlug: string }
  | { kind: 'not_terminal'; status: RunStatus }
  | { kind: 'not_restartable'; status: RunStatus }
  | { kind: 'input_unavailable' }
  // Another run is in flight on the same (agent, thread): a human explicitly
  // restarting into a busy thread gets a clear 409, not a silent queue.
  | { kind: 'thread_busy' }
  | { kind: 'restarted'; runId: string; taskId: string; agentId: string; channelId: string }

export const restartRun = async (
  prisma: PrismaClient,
  actorContext: AuthorizedActionContext,
  input: { organizationId: string; runId: string },
): Promise<RestartRunResult> => {
  const run = await loadRunForOrg(prisma, input.runId, input.organizationId)
  if (!run) return { kind: 'not_found' }

  // A PA presence represents one person in a shared room. A colleague may be
  // able to read the room, but cannot restart work under that person's PA.
  if (
    run.principalUserId
    && actorContext.actor.actorId !== run.principalUserId
  ) return { kind: 'not_found' }

  const productSlug = handoffProductSlug(run.triggerMessageMetadata)
  if (productSlug) return { kind: 'handoff_managed', productSlug }

  if (ACTIVE_RUN_STATUSES.includes(run.status)) {
    return { kind: 'not_terminal', status: run.status }
  }
  if (!RESTARTABLE_RUN_STATUSES.includes(run.status)) {
    return { kind: 'not_restartable', status: run.status }
  }
  if (!run.triggerMessageId) {
    return { kind: 'input_unavailable' }
  }
  // The original input must still exist to replay it.
  const message = await prisma.message.findUnique({
    where: { id: run.triggerMessageId },
    select: { id: true, content: true },
  })
  if (!message) return { kind: 'input_unavailable' }

  const created = await prisma.$transaction(async (tx) => {
    // Same (agent, thread) slot as every other run-creation path: restarting
    // into a busy thread is rejected, never silently queued.
    if (await isThreadRunSlotBusy(tx, {
      agentId: run.agentId,
      ...(run.principalUserId ? { principalUserId: run.principalUserId } : {}),
      threadId: run.threadId,
    })) {
      return { busy: true as const }
    }
    const newRun = await tx.run.create({
      data: {
        agentId: run.agentId,
        principalUserId: run.principalUserId,
        status: 'pending',
        threadId: run.threadId,
        triggerMessageId: message.id,
        restartOfRunId: run.id,
        // A restart replays the same trigger message, so it inherits the
        // original run's placement judgement rather than silently re-defaulting.
        replyPlacement: run.replyPlacement,
      },
      select: { id: true },
    })
    const newTask = await tx.task.create({
      data: {
        agentId: run.agentId,
        organizationId: input.organizationId,
        purpose: message.content.slice(0, 200),
        runId: newRun.id,
        status: 'inbox',
      },
      select: { id: true },
    })
    const queued = await enqueueRunExecution(
      tx,
      {
        actorContext: withActionContext(actorContext, {
          agentId: parseAgentId(run.agentId),
          channelId: parseChannelId(run.channelId),
          ...(run.principalUserId
            ? { effectiveUserId: parseUserId(run.principalUserId) }
            : {}),
          taskId: parseTaskId(newTask.id),
          threadId: parseThreadId(run.threadId),
        }),
        agentId: parseAgentId(run.agentId),
        ...(run.principalUserId ? { principalUserId: run.principalUserId } : {}),
        interactive: actorContext.actor.actorType === 'user',
        messageId: message.id,
        runId: parseRunId(newRun.id),
        taskId: parseTaskId(newTask.id),
        threadId: parseThreadId(run.threadId),
      },
      // A fresh run id keys the job so it never collides with the original run's
      // enqueue key (`run:<messageId>:<agentId>`), which would be a no-op.
      `run:restart:${newRun.id}`,
    )
    if (!queued) {
      throw new Error('Restart enqueue conflict')
    }
    return { runId: newRun.id, taskId: newTask.id }
  })

  if ('busy' in created) {
    return { kind: 'thread_busy' }
  }

  return {
    kind: 'restarted',
    runId: created.runId,
    taskId: created.taskId,
    agentId: run.agentId,
    channelId: run.channelId,
  }
}
