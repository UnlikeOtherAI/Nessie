import type { PrismaClient } from '@prisma/client'
import { exponentialBackoffMs } from '@nessie/runtime'
import {
  parseAgentId,
  parseChannelId,
  parseRunId,
  parseTaskId,
  parseThreadId,
  RUN_AUTO_CONTINUATION_TOPIC,
  withActionContext,
  type RunAutoContinuationJobPayload,
  type RunExecuteJobPayload,
} from '@nessie/schemas'
import { enqueueQueueJob, enqueueRunExecution } from '../../queue.js'
import { isThreadRunSlotBusy } from '../thread-serialization.js'
import { resolveAutoContinuations } from '../run-budget.js'
import { claimCheckpointForRun } from './checkpoint.js'
import type { ExecutionDependencies, RunContext } from './types.js'

// Non-interactive continuation (spec §5).
//
// A trigger, schedule, workflow, or drained batch has nobody to ask "shall I
// keep going?", so the worker answers for it: the checkpointed work is picked
// up by a fresh run, up to NESSIE_RUN_AUTO_CONTINUATIONS generations. An
// interactive run never auto-continues — it stops and offers the affordance.

// A live human conversational turn is the ONLY interactive case; automation
// leaves `interactive` unset, matching the budget gate's own exemption test.
export const isInteractiveRun = (payload: RunExecuteJobPayload): boolean =>
  payload.interactive === true

export const shouldAutoContinue = (input: {
  generation: number
  payload: RunExecuteJobPayload
}): boolean =>
  !isInteractiveRun(input.payload)
  && input.generation <= resolveAutoContinuations()

// How many times a continuation tries for a busy slot before it leaves the
// stopped work to a person's Continue press or reply, and how long it waits
// between tries: 15 s doubling to at most 5 min, about 45 min in all.
const AUTO_CONTINUATION_ATTEMPTS = 12
const autoContinuationWaitMs = (attempt: number): number =>
  exponentialBackoffMs({ attempt: attempt - 1, baseMs: 15_000, capMs: 5 * 60_000 })

/** The continuation a stopped run plans for itself, from its own job and context. */
export const enqueueAutoContinuation = async (
  deps: ExecutionDependencies,
  payload: RunExecuteJobPayload,
  context: RunContext,
  input: { checkpointId: string },
): Promise<string | null> =>
  startAutoContinuation(deps.prisma, {
    attempt: 1,
    checkpointId: input.checkpointId,
    source: payload,
    stoppedRun: {
      agentId: context.agent.id,
      channelId: context.channel.id,
      id: context.run.id,
      organizationId: context.channel.organizationId,
      principalUserId: context.run.principalUserId ?? null,
      replyPlacement: context.run.replyPlacement,
      threadId: context.run.threadId,
    },
  })

/**
 * Start the continuation run: run + task + queue job + checkpoint claim in one
 * transaction, mirroring every other run-creation path.
 *
 * Returns null when it does not start now. A checkpoint someone already
 * resumed — a Continue press, or a reply from a person who may read it — has
 * nothing left to continue. A taken (agent, thread) slot is waited for: the
 * continuation queues itself again (`RUN_AUTO_CONTINUATION_TOPIC`) rather
 * than leaving the stopped work to whichever run holds the slot, which picks
 * up no checkpoint it was not handed (`loadRunCheckpointForRun`). The
 * per-(agent, thread) single-run invariant is never broken to force one.
 */
export const startAutoContinuation = async (
  prisma: PrismaClient,
  continuation: RunAutoContinuationJobPayload,
): Promise<string | null> =>
  prisma.$transaction(async (tx) => {
    const { source, stoppedRun } = continuation
    const checkpoint = await tx.runCheckpoint.findUnique({
      where: { id: continuation.checkpointId },
      select: { consumedByRunId: true },
    })
    if (!checkpoint || checkpoint.consumedByRunId !== null) return null

    if (await isThreadRunSlotBusy(tx, {
      agentId: stoppedRun.agentId,
      ...(stoppedRun.principalUserId ? { principalUserId: stoppedRun.principalUserId } : {}),
      threadId: stoppedRun.threadId,
    })) {
      if (continuation.attempt < AUTO_CONTINUATION_ATTEMPTS) {
        await enqueueQueueJob(tx, {
          delayMs: autoContinuationWaitMs(continuation.attempt),
          idempotencyKey: `run:continue:wait:${continuation.checkpointId}:${continuation.attempt + 1}`,
          payload: { ...continuation, attempt: continuation.attempt + 1 },
          topic: RUN_AUTO_CONTINUATION_TOPIC,
        })
      } else {
        console.warn(
          `[worker] run ${stoppedRun.id} stopped waiting to auto-continue; `
          + 'its checkpoint stays for a Continue press or reply',
        )
      }
      return null
    }

    const run = await tx.run.create({
      data: {
        agentId: stoppedRun.agentId,
        continuationOfRunId: stoppedRun.id,
        principalUserId: stoppedRun.principalUserId,
        // A continuation has the same conversation delivery contract as the
        // run that checkpointed it. Dropping `channel` here makes the resolver
        // fall back to a hidden peer brief's root and hides later parts.
        replyPlacement: stoppedRun.replyPlacement,
        promptOverride: source.promptOverride ?? null,
        status: 'pending',
        threadId: stoppedRun.threadId,
        triggerMessageId: source.messageId,
      },
      select: { id: true },
    })

    const task = await tx.task.create({
      data: {
        agentId: stoppedRun.agentId,
        organizationId: stoppedRun.organizationId,
        purpose: `Continuation of run ${stoppedRun.id}`.slice(0, 200),
        runId: run.id,
        status: 'inbox',
      },
      select: { id: true },
    })

    if (!await claimCheckpointForRun(tx, { checkpointId: continuation.checkpointId, runId: run.id })) {
      // Someone else already claimed the checkpoint; there is nothing for this
      // continuation to resume from, so roll the whole unit back.
      throw new Error('CHECKPOINT_ALREADY_CONSUMED')
    }

    // Built explicitly rather than spread: the parent plan / workflow linkage
    // must NOT carry over. The stopping run already reported its outcome to the
    // parent step (completion and failure both do), so re-linking would advance
    // the workflow a second time.
    await enqueueRunExecution(
      tx,
      {
        actorContext: withActionContext(source.actorContext, {
          agentId: parseAgentId(stoppedRun.agentId),
          channelId: parseChannelId(stoppedRun.channelId),
          taskId: parseTaskId(task.id),
          threadId: parseThreadId(stoppedRun.threadId),
        }),
        agentId: source.agentId,
        ...(stoppedRun.principalUserId ? { principalUserId: stoppedRun.principalUserId } : {}),
        interactive: false,
        messageId: source.messageId,
        ...(source.promptOverride ? { promptOverride: source.promptOverride } : {}),
        runId: parseRunId(run.id),
        taskId: parseTaskId(task.id),
        threadId: source.threadId,
      },
      `run:continue:${run.id}`,
    )

    await tx.taskEvent.create({
      data: {
        eventType: 'run.continued',
        payload: {
          auto: true,
          continuationOfRunId: stoppedRun.id,
          fromCheckpointId: continuation.checkpointId,
          runId: run.id,
        },
        taskId: task.id,
      },
    })

    return run.id
  })
