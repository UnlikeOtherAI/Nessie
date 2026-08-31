import {
  parseAgentId,
  parseChannelId,
  parseRunId,
  parseTaskId,
  parseThreadId,
  withActionContext,
  type RunExecuteJobPayload,
} from '@nessie/schemas'
import { enqueueRunExecution } from '../../queue.js'
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

/**
 * Enqueue the continuation run: run + task + queue job + checkpoint claim in
 * one transaction, mirroring every other run-creation path.
 *
 * Returns null when the (agent, thread) run slot is already taken — a batched
 * follow-up run is coming anyway, and it picks up the same checkpoint through
 * the ordinary auto-load. The per-(agent, thread) single-run invariant is never
 * broken to force a continuation.
 */
export const enqueueAutoContinuation = async (
  deps: ExecutionDependencies,
  payload: RunExecuteJobPayload,
  context: RunContext,
  input: { checkpointId: string },
): Promise<string | null> =>
  deps.prisma.$transaction(async (tx) => {
    if (await isThreadRunSlotBusy(tx, {
      agentId: context.agent.id,
      ...(context.run.principalUserId
        ? { principalUserId: context.run.principalUserId }
        : {}),
      threadId: context.run.threadId,
    })) {
      return null
    }

    const run = await tx.run.create({
      data: {
        agentId: context.agent.id,
        continuationOfRunId: context.run.id,
        principalUserId: context.run.principalUserId ?? null,
        status: 'pending',
        threadId: context.run.threadId,
        triggerMessageId: payload.messageId,
      },
      select: { id: true },
    })

    const task = await tx.task.create({
      data: {
        agentId: context.agent.id,
        organizationId: context.channel.organizationId,
        purpose: `Continuation of run ${context.run.id}`.slice(0, 200),
        runId: run.id,
        status: 'inbox',
      },
      select: { id: true },
    })

    if (!await claimCheckpointForRun(tx, { checkpointId: input.checkpointId, runId: run.id })) {
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
        actorContext: withActionContext(payload.actorContext, {
          agentId: parseAgentId(context.agent.id),
          channelId: parseChannelId(context.channel.id),
          taskId: parseTaskId(task.id),
          threadId: parseThreadId(context.run.threadId),
        }),
        agentId: payload.agentId,
        ...(context.run.principalUserId
          ? { principalUserId: context.run.principalUserId }
          : {}),
        interactive: false,
        messageId: payload.messageId,
        ...(payload.promptOverride ? { promptOverride: payload.promptOverride } : {}),
        runId: parseRunId(run.id),
        taskId: parseTaskId(task.id),
        threadId: payload.threadId,
      },
      `run:continue:${run.id}`,
    )

    await tx.taskEvent.create({
      data: {
        eventType: 'run.continued',
        payload: {
          auto: true,
          continuationOfRunId: context.run.id,
          fromCheckpointId: input.checkpointId,
          runId: run.id,
        },
        taskId: task.id,
      },
    })

    return run.id
  })
