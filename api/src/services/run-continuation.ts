import type { PrismaClient } from '@prisma/client'
import type { AuthorizedActionContext, RunStatus } from '@nessie/schemas'

import { canUserReadRunBasis } from './run-disclosure.js'
import {
  ACTIVE_RUN_STATUSES,
  handoffProductSlug,
  loadRunForActor,
} from './run-access.js'
import {
  ResumeNotEntitled,
  ResumeRollback,
  resumeSuspendedRun,
} from './run-resume-core.js'

// Why a terminal run cannot be continued. All three map to the single
// `RUN_NOT_CONTINUABLE` 409; the detail only shapes the message.
export type NotContinuableDetail = 'not_terminal' | 'no_checkpoint' | 'input_unavailable'

export type ContinueRunResult =
  | { kind: 'not_found' }
  | { kind: 'handoff_managed'; productSlug: string }
  | { kind: 'not_continuable'; detail: NotContinuableDetail; status: RunStatus }
  // The checkpoint was already claimed — by another Continue tap, a
  // natural-language resume, or the worker's auto-continue.
  | { kind: 'checkpoint_consumed' }
  // Another run is in flight on the same (agent, thread) slot.
  | { kind: 'busy' }
  | { kind: 'continued'; runId: string; taskId: string; agentId: string; channelId: string }

/**
 * Resume a run that stopped at a policy ceiling, seeding the fresh run from the
 * stopped run's durable `RunCheckpoint`.
 *
 * Authorization is deliberately the same access that could have triggered the
 * run in the first place — continuing is "post this turn again", not a new
 * privilege. `loadRunForActor` is that gate: the agent must be visible to this
 * person and the run's channel public in their organisation or one they joined.
 * The continuation run is attributed to the caller.
 *
 * What this module owns is that gate. The continuation sequence itself —
 * slot check, set-once checkpoint claim, run, task, `run.continued` event and
 * enqueue, all in one transaction — belongs to `resumeSuspendedRun`
 * (`run-resume-core.ts`), which the approval and card resumes also call. This
 * used to be a second copy of those six steps, which is how the two of them
 * ended up disagreeing about the actor-context wrapping order.
 */
export const continueRun = async (
  prisma: PrismaClient,
  actorContext: AuthorizedActionContext,
  input: { organizationId: string; runId: string },
): Promise<ContinueRunResult> => {
  const run = await loadRunForActor(prisma, input.runId, {
    organizationId: input.organizationId,
    userId: actorContext.actor.actorId,
  })
  if (!run) return { kind: 'not_found' }

  // A PA presence belongs to its principal, even though colleagues can read
  // the shared channel that contains the reply.
  if (
    run.principalUserId
    && actorContext.actor.actorId !== run.principalUserId
  ) return { kind: 'not_found' }

  // A handoff-managed run's lifecycle belongs to the product, never to a
  // generic continue.
  const productSlug = handoffProductSlug(run.triggerMessageMetadata)
  if (productSlug) return { kind: 'handoff_managed', productSlug }

  if (ACTIVE_RUN_STATUSES.includes(run.status)) {
    return { kind: 'not_continuable', detail: 'not_terminal', status: run.status }
  }

  const checkpoint = await prisma.runCheckpoint.findUnique({
    where: { runId: run.id },
    select: { id: true, consumedByRunId: true },
  })
  if (!checkpoint) {
    return { kind: 'not_continuable', detail: 'no_checkpoint', status: run.status }
  }
  if (checkpoint.consumedByRunId !== null) {
    return { kind: 'checkpoint_consumed' }
  }

  // The continuation replays the same input the stopped run was given; the
  // checkpoint supplies everything the run had learned since.
  if (!run.triggerMessageId) {
    return { kind: 'not_continuable', detail: 'input_unavailable', status: run.status }
  }
  const triggerMessageId = run.triggerMessageId

  try {
    const resumed = await prisma.$transaction((tx) =>
      resumeSuspendedRun(tx, {
        // Read outside the claim transaction on purpose: run basis scopes are
        // written by the run that produced them, never by this one, so there
        // is nothing here to serialize against.
        entitledToClaim: () =>
          canUserReadRunBasis(prisma, {
            organizationId: input.organizationId,
            runId: run.id,
            userId: actorContext.actor.actorId,
          }),
        interactive: actorContext.actor.actorType === 'user',
        organizationId: input.organizationId,
        // A fresh run id keys the job so it never collides with the original
        // run's enqueue key (`run:<messageId>:<agentId>`), which would be a no-op.
        queueKeyPrefix: 'run:continue',
        resumeActorContext: actorContext,
        runId: run.id,
        // Already terminal: a Continue press is only offered on a stopped run,
        // so there is no parked status to claim.
        suspendedStatus: null,
        triggerMessageId,
      }))
    return {
      kind: 'continued',
      runId: resumed.runId,
      taskId: resumed.taskId,
      agentId: run.agentId,
      channelId: run.channelId,
    }
  } catch (error) {
    if (error instanceof ResumeNotEntitled) {
      return { kind: 'not_continuable', detail: 'no_checkpoint', status: run.status }
    }
    if (error instanceof ResumeRollback) {
      if (error.reason === 'busy') return { kind: 'busy' }
      if (error.reason === 'already_resumed') return { kind: 'checkpoint_consumed' }
      // `invalid_resume_state` here means the trigger message vanished between
      // the load and the claim; `run_not_waiting` cannot occur with a null
      // `suspendedStatus`.
      return { kind: 'not_continuable', detail: 'input_unavailable', status: run.status }
    }
    throw error
  }
}
