import type { PrismaClient } from '@prisma/client'
import {
  parseAgentId,
  parseChannelId,
  parseRunId,
  parseTaskId,
  parseThreadId,
  parseUserId,
  withActionContext,
  withDelegatedSystemDmIdentity,
  type AuthorizedActionContext,
  type RunStatus,
} from '@nessie/schemas'
import { isThreadRunSlotBusy } from '@nessie/db'

import { enqueueRunExecution } from '../queue/pgqueue.js'
import { findThreadForUser } from './messages.js'
import { canUserReadRunBasis } from './run-disclosure.js'
import {
  ACTIVE_RUN_STATUSES,
  handoffProductSlug,
  loadRunForOrg,
} from './run-access.js'

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
 * run in the first place (public channel or channel membership within the
 * caller's organization) — continuing is "post this turn again", not a new
 * privilege. The continuation run is attributed to the caller.
 *
 * Claim + run + task + enqueue happen in one transaction. The claim is the
 * single conditional update the spec mandates (`consumedByRunId IS NULL`), so
 * two concurrent Continues produce exactly one continuation run.
 */
export const continueRun = async (
  prisma: PrismaClient,
  actorContext: AuthorizedActionContext,
  input: { organizationId: string; runId: string },
): Promise<ContinueRunResult> => {
  const run = await loadRunForOrg(prisma, input.runId, input.organizationId)
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

  const thread = await findThreadForUser(
    prisma,
    run.threadId,
    actorContext.actor.actorId,
    input.organizationId,
  )
  if (!thread) return { kind: 'not_found' }

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

  // Continuing is "post this turn again", so channel access is the right gate
  // for *starting* a run — but the checkpoint carries the stopped run's work
  // state, and claiming it is one-shot. Someone who cannot reach that run's
  // sources would consume the entitled person's resume and get a run that
  // withholds the note from itself anyway, quietly redoing the work.
  const entitled = await canUserReadRunBasis(prisma, {
    organizationId: input.organizationId,
    runId: run.id,
    userId: actorContext.actor.actorId,
  })
  if (!entitled) {
    return { kind: 'not_continuable', detail: 'no_checkpoint', status: run.status }
  }

  // The continuation replays the same input the stopped run was given; the
  // checkpoint supplies everything the run had learned since.
  if (!run.triggerMessageId) {
    return { kind: 'not_continuable', detail: 'input_unavailable', status: run.status }
  }
  const message = await prisma.message.findUnique({
    where: { id: run.triggerMessageId },
    select: { id: true, content: true },
  })
  if (!message) {
    return { kind: 'not_continuable', detail: 'input_unavailable', status: run.status }
  }

  const created = await prisma.$transaction(async (tx) => {
    // Same (agent, thread) slot as every other run-creation path: continuing
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
        continuationOfRunId: run.id,
        // A continuation resumes the same exchange, so it inherits the original
        // run's placement judgement rather than silently re-defaulting.
        replyPlacement: run.replyPlacement,
      },
      select: { id: true },
    })

    // Set-once claim: the checkpoint belongs to exactly one continuation run.
    // A lost race writes nothing else in this transaction, so the early return
    // rolls the whole unit back.
    const claimed = await tx.runCheckpoint.updateMany({
      where: { id: checkpoint.id, consumedByRunId: null },
      data: { consumedByRunId: newRun.id, consumedAt: new Date() },
    })
    if (claimed.count !== 1) {
      return { consumed: true as const }
    }

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
    await tx.taskEvent.create({
      data: {
        eventType: 'run.continued',
        payload: {
          auto: false,
          continuationOfRunId: run.id,
          fromCheckpointId: checkpoint.id,
          runId: newRun.id,
        },
        taskId: newTask.id,
      },
    })

    const queued = await enqueueRunExecution(
      tx,
      {
        // A PA shared-channel presence keeps its own principal, so it is
        // stamped last; otherwise a single-member system DM stamps the person
        // who is continuing, who is necessarily that DM's one member (the
        // route gates on the same channel access that could have triggered the
        // run). Without this a continued Agent Designer run loses every
        // identity-delegated tool the original had.
        actorContext: withActionContext(
          withDelegatedSystemDmIdentity(actorContext, {
            systemChannelType: run.channelSystemChannelType,
          }),
          {
            agentId: parseAgentId(run.agentId),
            channelId: parseChannelId(run.channelId),
            ...(run.principalUserId
              ? { effectiveUserId: parseUserId(run.principalUserId) }
              : {}),
            taskId: parseTaskId(newTask.id),
            threadId: parseThreadId(run.threadId),
          },
        ),
        agentId: parseAgentId(run.agentId),
        ...(run.principalUserId ? { principalUserId: run.principalUserId } : {}),
        interactive: actorContext.actor.actorType === 'user',
        messageId: message.id,
        runId: parseRunId(newRun.id),
        taskId: parseTaskId(newTask.id),
        threadId: parseThreadId(run.threadId),
      },
      // A fresh run id keys the job so it never collides with the original
      // run's enqueue key (`run:<messageId>:<agentId>`), which would be a no-op.
      `run:continue:${newRun.id}`,
    )
    if (!queued) {
      throw new Error('Continue enqueue conflict')
    }
    return { runId: newRun.id, taskId: newTask.id }
  })

  if ('busy' in created) return { kind: 'busy' }
  if ('consumed' in created) return { kind: 'checkpoint_consumed' }

  return {
    kind: 'continued',
    runId: created.runId,
    taskId: created.taskId,
    agentId: run.agentId,
    channelId: run.channelId,
  }
}
