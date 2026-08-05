import type { PrismaClient, RunReplyPlacement } from '@prisma/client'
import {
  parseAgentId,
  parseChannelId,
  parseRunId,
  parseTaskId,
  parseThreadId,
  withActionContext,
  type AuthorizedActionContext,
  type RunStatus,
} from '@nessie/schemas'

import { enqueueRunExecution } from '../queue/pgqueue.js'
import { isThreadRunSlotBusy } from '@nessie/db'

// Statuses a run can be in while it is still live — the set the status surface
// lists and the only set from which a run can be cancelled.
const ACTIVE_RUN_STATUSES: RunStatus[] = ['pending', 'running', 'waiting_approval']

// A run is restartable only from a genuinely finished, non-successful terminal
// state. A `completed` run (including a budget-stop that delivered a partial
// answer) is not re-run; a budget-stop that produced nothing ends `failed`, so
// it is covered here.
const RESTARTABLE_RUN_STATUSES: RunStatus[] = ['failed', 'cancelled']

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

// A run scoped to the caller's organization, with the trigger message's metadata
// hydrated so the handoff-guard can inspect it without a second query.
type OrgRun = {
  id: string
  agentId: string
  status: RunStatus
  channelId: string
  threadId: string
  triggerMessageId: string | null
  triggerMessageMetadata: unknown
  // Pre-run reply-placement judgement, replayed onto a restarted run so the
  // re-run lands where the original one was judged to belong.
  replyPlacement: RunReplyPlacement | null
}

const loadRunForOrg = async (
  prisma: PrismaClient,
  runId: string,
  organizationId: string,
): Promise<OrgRun | null> => {
  const run = await prisma.run.findFirst({
    where: { id: runId, thread: { channel: { organizationId } } },
    select: {
      id: true,
      agentId: true,
      status: true,
      threadId: true,
      triggerMessageId: true,
      replyPlacement: true,
      thread: { select: { channelId: true } },
      triggerMessage: { select: { metadata: true } },
    },
  })
  if (!run) return null
  return {
    id: run.id,
    agentId: run.agentId,
    status: run.status,
    channelId: run.thread.channelId,
    threadId: run.threadId,
    triggerMessageId: run.triggerMessageId,
    triggerMessageMetadata: run.triggerMessage?.metadata ?? null,
    replyPlacement: run.replyPlacement,
  }
}

// A run driven by an integration handoff (e.g. a DeepWater research launch)
// carries strict cross-service invariants that a generic cancel must never
// touch. Detection reads the launch message's server-authored `integrationLaunch`
// metadata; the caller is redirected to the product's own cancel path.
const handoffProductSlug = (metadata: unknown): string | null => {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null
  const launch = (metadata as Record<string, unknown>)['integrationLaunch']
  if (!launch || typeof launch !== 'object' || Array.isArray(launch)) return null
  const slug = (launch as Record<string, unknown>)['productSlug']
  return typeof slug === 'string' && slug.length > 0 ? slug : null
}

export const listActiveRuns = async (
  prisma: PrismaClient,
  organizationId: string,
): Promise<ActiveRunSummary[]> => {
  const runs = await prisma.run.findMany({
    where: {
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
}

// Recently-ended runs that can be restarted (failed or cancelled), so the UI can
// offer the "restart" control next to the live-run list. Handoff-bound runs are
// excluded — they are never restartable through this path.
export const listRestartableRuns = async (
  prisma: PrismaClient,
  organizationId: string,
): Promise<RestartableRunSummary[]> => {
  const runs = await prisma.run.findMany({
    where: {
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
    if (await isThreadRunSlotBusy(tx, { agentId: run.agentId, threadId: run.threadId })) {
      return { busy: true as const }
    }
    const newRun = await tx.run.create({
      data: {
        agentId: run.agentId,
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
          taskId: parseTaskId(newTask.id),
          threadId: parseThreadId(run.threadId),
        }),
        agentId: parseAgentId(run.agentId),
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
