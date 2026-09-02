import { type Prisma } from '@prisma/client'
import { isThreadRunSlotBusy } from '@nessie/db'
import {
  AuthorizedActionContextSchema,
  parseAgentId,
  parseChannelId,
  parseRunId,
  parseTaskId,
  parseThreadId,
  withActionContext,
  type AuthorizedActionContext,
} from '@nessie/schemas'

import { enqueueRunExecution } from '../queue/pgqueue.js'

/**
 * Bringing a suspended run back.
 *
 * Two things suspend a run because a person owes it an answer — a tool
 * approval and an interactive card — and resuming is the same seven steps
 * either way: terminalize the parked run, check the thread slot, claim its
 * checkpoint set-once, create the continuation, its task and its
 * `run.continued` event, and enqueue. Shared so the claim-once discipline
 * cannot be got subtly wrong in a second copy; each caller supplies its own
 * parked status, provenance and queue key.
 */

export type RunResumeFailure =
  | 'already_resumed'
  | 'busy'
  | 'invalid_resume_state'
  | 'run_not_waiting'

export class ResumeRollback extends Error {
  constructor(readonly reason: RunResumeFailure) {
    super(reason)
  }
}

export type ResumedRun = { runId: string; taskId: string }

export const resumeSuspendedRun = async (
  tx: Prisma.TransactionClient,
  input: {
    /** Extra fields merged onto the continuation's actor context (an approval proof). */
    actorContextExtra?: Record<string, unknown>
    /** Provenance merged into the `run.continued` TaskEvent payload. */
    eventPayload: Record<string, Prisma.InputJsonValue>
    interactive: boolean
    organizationId: string
    /** The enqueue-time actor context captured when the run suspended. */
    resumeActorContext: AuthorizedActionContext
    /** The parked run, and the status it must still be in. */
    runId: string
    suspendedStatus: 'waiting_approval' | 'waiting_input'
    /** Namespaces the idempotency key, e.g. `run:card`. */
    queueKeyPrefix: string
    /** The trigger message the continuation replays; must match the parked run's. */
    triggerMessageId: string
  },
): Promise<ResumedRun> => {
  const run = await tx.run.findFirst({
    select: {
      agentId: true,
      principalUserId: true,
      replyPlacement: true,
      thread: { select: { channelId: true } },
      threadId: true,
      triggerMessageId: true,
    },
    where: { id: input.runId },
  })
  if (!run || !run.triggerMessageId || run.triggerMessageId !== input.triggerMessageId) {
    throw new ResumeRollback('invalid_resume_state')
  }
  const message = await tx.message.findUnique({
    select: { content: true, id: true },
    where: { id: input.triggerMessageId },
  })
  if (!message) throw new ResumeRollback('invalid_resume_state')

  // Terminalize before the slot check, or the run would be found busy by itself.
  const terminalized = await tx.run.updateMany({
    data: { finishedAt: new Date(), status: 'completed' },
    where: { id: input.runId, status: input.suspendedStatus },
  })
  if (terminalized.count !== 1) throw new ResumeRollback('run_not_waiting')

  if (
    await isThreadRunSlotBusy(tx, {
      agentId: run.agentId,
      ...(run.principalUserId ? { principalUserId: run.principalUserId } : {}),
      threadId: run.threadId,
    })
  ) {
    throw new ResumeRollback('busy')
  }

  const checkpoint = await tx.runCheckpoint.findUnique({
    select: { consumedByRunId: true, id: true },
    where: { runId: input.runId },
  })
  if (!checkpoint || checkpoint.consumedByRunId !== null) {
    throw new ResumeRollback('already_resumed')
  }

  const continuation = await tx.run.create({
    data: {
      agentId: run.agentId,
      continuationOfRunId: input.runId,
      principalUserId: run.principalUserId,
      replyPlacement: run.replyPlacement,
      status: 'pending',
      threadId: run.threadId,
      triggerMessageId: message.id,
    },
    select: { id: true },
  })
  const claimed = await tx.runCheckpoint.updateMany({
    data: { consumedAt: new Date(), consumedByRunId: continuation.id },
    where: { consumedByRunId: null, id: checkpoint.id },
  })
  if (claimed.count !== 1) throw new ResumeRollback('already_resumed')

  const task = await tx.task.create({
    data: {
      agentId: run.agentId,
      organizationId: input.organizationId,
      purpose: message.content.slice(0, 200),
      runId: continuation.id,
      status: 'inbox',
    },
    select: { id: true },
  })
  await tx.taskEvent.create({
    data: {
      eventType: 'run.continued',
      payload: {
        ...input.eventPayload,
        auto: false,
        continuationOfRunId: input.runId,
        fromCheckpointId: checkpoint.id,
        runId: continuation.id,
      },
      taskId: task.id,
    },
  })

  const actorContext = AuthorizedActionContextSchema.parse({
    ...withActionContext(input.resumeActorContext, {
      agentId: parseAgentId(run.agentId),
      channelId: parseChannelId(run.thread.channelId),
      taskId: parseTaskId(task.id),
      threadId: parseThreadId(run.threadId),
    }),
    ...(input.actorContextExtra ?? {}),
  })
  const queued = await enqueueRunExecution(
    tx,
    {
      actorContext,
      agentId: parseAgentId(run.agentId),
      ...(run.principalUserId ? { principalUserId: run.principalUserId } : {}),
      interactive: input.interactive,
      messageId: message.id,
      runId: parseRunId(continuation.id),
      taskId: parseTaskId(task.id),
      threadId: parseThreadId(run.threadId),
    },
    `${input.queueKeyPrefix}:${continuation.id}`,
  )
  if (!queued) throw new Error('Run continuation enqueue conflict')

  return { runId: continuation.id, taskId: task.id }
}
