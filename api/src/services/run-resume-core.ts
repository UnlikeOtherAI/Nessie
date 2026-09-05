import { type Prisma } from '@prisma/client'
import { isThreadRunSlotBusy } from '@nessie/db'
import {
  AuthorizedActionContextSchema,
  parseAgentId,
  parseChannelId,
  parseRunId,
  parseTaskId,
  parseThreadId,
  parseUserId,
  withActionContext,
  withDelegatedSystemDmIdentity,
  type AuthorizedActionContext,
} from '@nessie/schemas'

import { enqueueRunExecution } from '../queue/pgqueue.js'

/**
 * Bringing a stopped run back — the one implementation.
 *
 * Three things stop a run that a person can then restart: a tool approval, an
 * interactive card, and a policy ceiling the person presses Continue past.
 * Resuming is the same sequence in all three: terminalize the parked run (when
 * it is still parked), check the thread slot, claim its checkpoint set-once,
 * create the continuation, its task and its `run.continued` event, and enqueue.
 * Shared so the claim-once discipline cannot be got subtly wrong in a second
 * copy; each caller supplies its own parked status, provenance and queue key.
 *
 * The Continue press differs in exactly two ways, and both are seams here
 * rather than a second copy: its run is already terminal (`suspendedStatus:
 * null`), and it must pass an entitlement gate before the one-shot claim
 * (`entitledToClaim`).
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

/**
 * The caller's own pre-claim gate said no.
 *
 * Deliberately not a `ResumeRollback` reason: `RunResumeFailure` is the set the
 * approval effect renders, and only a caller that passed `entitledToClaim` can
 * ever see this. It still aborts the transaction, so nothing is claimed.
 */
export class ResumeNotEntitled extends Error {
  constructor() {
    super('not_entitled')
  }
}

export type ResumedRun = { runId: string; taskId: string }

export const resumeSuspendedRun = async (
  tx: Prisma.TransactionClient,
  input: {
    /** Extra fields merged onto the continuation's actor context (an approval proof). */
    actorContextExtra?: Record<string, unknown>
    /**
     * Pre-claim entitlement gate, evaluated before anything is written.
     *
     * The Continue press is the one caller that has it: channel access is the
     * right gate for *starting* a run, but the checkpoint carries the stopped
     * run's work state and claiming it is one-shot, so someone who cannot read
     * that run's sources would consume the entitled person's resume and get a
     * run that withholds the notes from itself anyway.
     */
    entitledToClaim?: () => Promise<boolean>
    /** Provenance merged into the `run.continued` TaskEvent payload. */
    eventPayload?: Record<string, Prisma.InputJsonValue>
    interactive: boolean
    organizationId: string
    /** The enqueue-time actor context captured when the run suspended. */
    resumeActorContext: AuthorizedActionContext
    /**
     * The parked run, and the status it must still be in — or `null` when the
     * run already reached a terminal state (the Continue press), in which case
     * there is nothing to terminalize and no status to re-assert.
     */
    runId: string
    suspendedStatus: 'waiting_approval' | 'waiting_input' | null
    /** Namespaces the idempotency key, e.g. `run:card`. */
    queueKeyPrefix: string
    /** The trigger message the continuation replays; must match the parked run's. */
    triggerMessageId: string
  },
): Promise<ResumedRun> => {
  if (input.entitledToClaim && !(await input.entitledToClaim())) {
    throw new ResumeNotEntitled()
  }

  const run = await tx.run.findFirst({
    select: {
      agentId: true,
      principalUserId: true,
      replyPlacement: true,
      thread: {
        select: {
          channelId: true,
          channel: { select: { systemChannelType: true } },
        },
      },
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

  // Terminalize before the slot check, or the run would be found busy by
  // itself. A run that is already terminal (`suspendedStatus: null`) skips
  // this: there is no parked state to claim, and the slot check below is what
  // rejects a continue into a thread that has since started working again.
  if (input.suspendedStatus !== null) {
    const terminalized = await tx.run.updateMany({
      data: { finishedAt: new Date(), status: 'completed' },
      where: { id: input.runId, status: input.suspendedStatus },
    })
    if (terminalized.count !== 1) throw new ResumeRollback('run_not_waiting')
  }

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
        ...(input.eventPayload ?? {}),
        auto: false,
        continuationOfRunId: input.runId,
        fromCheckpointId: checkpoint.id,
        runId: continuation.id,
      },
      taskId: task.id,
    },
  })

  // The resumed run inherits the parked run's enqueue-time actor context, so a
  // correctly-stamped original stays correct. Re-asserting the destination's
  // own rule is what keeps it correct when the original was not: a `wait: true`
  // card is literally the run an unstamped card press would have produced.
  //
  // Wrapping order, settled here once because the two callers used to disagree
  // about it: the system-DM delegation is applied *first*, then the run's own
  // action fields. Both write `actionContext.effectiveUserId`, and the later
  // wrap wins — so a PA shared-channel presence keeps its own principal, while
  // an ordinary single-member system DM falls back to the person acting.
  // Without the delegated stamp a continued Agent Designer run loses every
  // identity-delegated tool the original had
  // (`worker/src/run/delegated-identity.ts`); without the principal landing
  // last, a PA presence's continuation would be attributed to whoever pressed.
  const actorContext = AuthorizedActionContextSchema.parse({
    ...withActionContext(
      withDelegatedSystemDmIdentity(input.resumeActorContext, {
        systemChannelType: run.thread.channel.systemChannelType,
      }),
      {
        agentId: parseAgentId(run.agentId),
        channelId: parseChannelId(run.thread.channelId),
        ...(run.principalUserId
          ? { effectiveUserId: parseUserId(run.principalUserId) }
          : {}),
        taskId: parseTaskId(task.id),
        threadId: parseThreadId(run.threadId),
      },
    ),
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
