import type { PrismaClient } from '@prisma/client'
import { isPersonAuthoredMessageMetadata, type RunExecuteJobPayload } from '@nessie/schemas'

import {
  executorLeaseAuditActor,
  executorLeaseExpiresAt,
  executorLeaseIdleExpiry,
  expireExecutorConversationLease,
  isExecutorLeaseLive,
  writeExecutorLeaseAudit,
} from './executor-conversation-lease.js'
import { ExecutorError } from './executor-errors.js'
import { bindPinnedExecutorLocalApps } from './executor-local-apps-binding.js'

/**
 * Why a lease in this conversation did not carry into this run. The facts the
 * model is told are derived from these; none of them names the executor.
 */
export type ExecutorLeaseRefusalReason =
  /** The job's actor is not the lease holder, is a channel-policy authorizer,
   * or carries another person as its effective user; or someone else pressed
   * the Continue, Restart, card answer or approval that brought the run back. */
  | 'actor_not_holder'
  /** Not a live human turn. */
  | 'not_interactive'
  /** The trigger is not the holder's own composer message. */
  | 'trigger_not_person'
  /** A drained batch folded in a message that is not the holder's own. */
  | 'batch_not_person'
  /** Ended, or past its idle or absolute window. */
  | 'lease_ended'
  /** The fresh re-resolution or its binding was refused: the machine is
   * offline, or a grant, policy or scope no longer allows it. */
  | 'executor_unavailable'

/** `live` is false when an already-bound run's lease has since ended or run
 * out; its bindings are then fenced at dispatch. */
export type ExecutorLeaseSummary = { executorId: string; expiresAt: Date; id: string; live: boolean }

/**
 * What run setup learned about the conversation lease, kept on the run
 * context so the prompt facts step can tell the model what it can reach.
 */
export type ExecutorLeaseCarryOutcome =
  /** No lease covers this conversation for this agent. */
  | { kind: 'no_lease' }
  /** The run was bound before setup — the launch run itself, or a re-driven
   * job whose earlier attempt already carried. `lease` is set when those
   * bindings were made under one. */
  | { kind: 'already_bound'; lease: ExecutorLeaseSummary | null }
  | { kind: 'carried'; bindingIds: string[]; lease: ExecutorLeaseSummary }
  | { kind: 'refused'; leaseId: string; reason: ExecutorLeaseRefusalReason }

type LeaseRow = {
  absoluteExpiresAt: Date
  actorUserId: string
  agentId: string
  endedAt: Date | null
  executorId: string
  id: string
  idleExpiresAt: Date
  launchRunId: string
  organizationId: string
  rootMessageId: string
}

type CarryMessage = {
  deletedAt: Date | null
  id: string
  metadata: unknown
  role: string
  rootMessageId: string | null
  threadId: string
  userId: string | null
}

const MESSAGE_SELECT = {
  deletedAt: true, id: true, metadata: true, role: true, rootMessageId: true, threadId: true, userId: true,
} as const

const LEASE_SELECT = {
  absoluteExpiresAt: true, actorUserId: true, agentId: true, endedAt: true, executorId: true,
  id: true, idleExpiresAt: true, launchRunId: true, organizationId: true, rootMessageId: true,
} as const

const summarize = (lease: LeaseRow, now: Date): ExecutorLeaseSummary => ({
  executorId: lease.executorId,
  expiresAt: executorLeaseExpiresAt(lease),
  id: lease.id,
  live: isExecutorLeaseLive(lease, now),
})

/** Condition 2: the job acts as the holder and as nobody else. */
const actsAsHolder = (job: RunExecuteJobPayload, lease: LeaseRow): boolean => {
  const context = job.actorContext
  return context.actor.actorType === 'user'
    && context.actor.actorId === lease.actorUserId
    && context.tenant.organizationId === lease.organizationId
    && context.actionContext.purpose !== 'channel.policy'
    && (context.actionContext.effectiveUserId === undefined
      || context.actionContext.effectiveUserId === lease.actorUserId)
}

/**
 * Condition 4: the holder typed it into a composer and sent it. The launch
 * message is the one exception, attested by the lease itself — it was written
 * in the same transaction as the lease by that person's own launch.
 */
const isHoldersOwnMessage = (message: CarryMessage, lease: LeaseRow, threadId: string): boolean =>
  message.threadId === threadId
  && message.role === 'user'
  && message.userId === lease.actorUserId
  && message.deletedAt === null
  && (isPersonAuthoredMessageMetadata(message.metadata) || message.id === lease.rootMessageId)

const alreadyBound = async (
  prisma: PrismaClient,
  runId: string,
  now: Date,
): Promise<ExecutorLeaseCarryOutcome> => {
  const binding = await prisma.executorBinding.findFirst({
    where: { runId, leaseId: { not: null } },
    select: { lease: { select: LEASE_SELECT } },
  })
  return { kind: 'already_bound', lease: binding?.lease ? summarize(binding.lease, now) : null }
}

class LeaseEndedDuringCarry extends Error {}

/**
 * A refusal of a live lease leaves a durable row, so whoever asks why a
 * follow-up lost machine tools, or whether someone else tried to reach a
 * holder's lease, has something to read. A lease that has ended is recorded
 * once, by its end, not again by every later turn in its conversation. The
 * row names the lease, never the machine's label, and writing it can never
 * fail the run it describes.
 */
const recordRefusal = async (
  prisma: PrismaClient,
  input: {
    job: RunExecuteJobPayload
    lease: LeaseRow
    now: Date
    reason: ExecutorLeaseRefusalReason
    runId: string
    triggerMessageId: string
  },
): Promise<void> => {
  const { job, lease } = input
  if (input.reason === 'lease_ended' || !isExecutorLeaseLive(lease, input.now)) return
  try {
    await prisma.$transaction((tx) => writeExecutorLeaseAudit(tx, {
      action: 'executor.run.carry_refused',
      actor: {
        actorId: job.actorContext.actor.actorId,
        actorType: job.actorContext.actor.actorType,
        requestId: job.actorContext.actionContext.requestId,
      },
      metadata: {
        agentId: lease.agentId,
        executorId: lease.executorId,
        holderUserId: lease.actorUserId,
        leaseId: lease.id,
        reason: input.reason,
        // A card or approval resume acts as the parked run's actor; the press
        // behind it may be someone else's, and that is who tried.
        resumedByUserId: job.resumedByUserId ?? null,
        runId: input.runId,
        triggerMessageId: input.triggerMessageId,
      },
      organizationId: lease.organizationId,
      outcome: 'denied',
      reason: input.reason,
      resourceId: input.runId,
      resourceType: 'executor_run',
    }))
  } catch (error) {
    console.warn('[executor-lease] could not record the carry refusal for run', input.runId, error)
  }
}

/**
 * Bind a follow-up run to the executor its conversation's lease names, when —
 * and only when — every structural condition of the conversation-lease plan
 * holds (docs/plans/2026-09-22-executor-local-apps/conversation-lease.md §2).
 * Otherwise nothing is bound and the reason is returned (and, while the lease
 * is live, written to the audit chain as `executor.run.carry_refused`). Called once by run
 * setup, immediately before the executor toolset is built. A refusal is never
 * thrown: every `ExecutorError` the re-resolution or binding raises becomes
 * `executor_unavailable`.
 */
export const carryForwardExecutorBindings = async (
  prisma: PrismaClient,
  input: { job: RunExecuteJobPayload; runId: string },
  now = new Date(),
): Promise<ExecutorLeaseCarryOutcome> => {
  const { job, runId } = input
  const run = await prisma.run.findUnique({
    where: { id: runId },
    select: {
      agentId: true,
      continuationOfRunId: true,
      restartOfRunId: true,
      thread: { select: { agentId: true, channelId: true } },
      threadId: true,
      triggerMessage: { select: MESSAGE_SELECT },
      _count: { select: { executorBindings: true } },
    },
  })
  if (!run) return { kind: 'no_lease' }
  // 1. A re-driven job is a no-op, never a conflict.
  if (run._count.executorBindings > 0) return alreadyBound(prisma, runId, now)
  const trigger = run.triggerMessage
  if (!trigger) return { kind: 'no_lease' }

  // 7 and 8 (agent). The conversation is the launch's reply thread — its root
  // — or, inside a thread that is a conversation with this agent, the thread.
  const inAgentConversation = run.thread.agentId === run.agentId
  const leases = await prisma.executorConversationLease.findMany({
    where: {
      agentId: run.agentId,
      threadId: run.threadId,
      ...(inAgentConversation ? {} : { rootMessageId: trigger.rootMessageId ?? trigger.id }),
    },
    orderBy: { createdAt: 'desc' },
    select: LEASE_SELECT,
    take: 20,
  })
  const actorId = job.actorContext.actor.actorId
  const lease = leases.find((entry) => entry.actorUserId === actorId && entry.endedAt === null)
    ?? leases.find((entry) => entry.actorUserId === actorId)
    ?? leases[0]
  if (!lease) return { kind: 'no_lease' }
  const refused = async (reason: ExecutorLeaseRefusalReason): Promise<ExecutorLeaseCarryOutcome> => {
    await recordRefusal(prisma, { job, lease, now, reason, runId, triggerMessageId: trigger.id })
    return { kind: 'refused', leaseId: lease.id, reason }
  }

  // 2. Continue and Restart already act as the person who pressed.
  if (!actsAsHolder(job, lease)) return refused('actor_not_holder')
  // 3.
  if (job.interactive !== true) return refused('not_interactive')
  // 6. A card answer or an approval resumes as the parked run's own actor,
  // whoever pressed it, so a continuation also needs the press to be the
  // holder's. Every continuation a press makes names its presser
  // (`resumeSuspendedRun`); one that names nobody is nobody's press.
  if (run.continuationOfRunId !== null && job.resumedByUserId !== lease.actorUserId) {
    return refused('actor_not_holder')
  }
  // 4. The replayed trigger of a Continue or Restart is checked the same way.
  if (job.messageId !== trigger.id || !isHoldersOwnMessage(trigger, lease, run.threadId)) {
    return refused('trigger_not_person')
  }
  // 5. Every message a drained batch folded in, not only its latest — and each
  // in this conversation, since a drain batches the whole container thread.
  if (job.batchMessageIds) {
    const ids = [...new Set(job.batchMessageIds)]
    const batch = await prisma.message.findMany({ where: { id: { in: ids } }, select: MESSAGE_SELECT })
    if (
      batch.length !== ids.length
      || !ids.includes(trigger.id)
      || batch.some((message) => !isHoldersOwnMessage(message, lease, run.threadId)
        || (!inAgentConversation && (message.rootMessageId ?? message.id) !== lease.rootMessageId))
    ) {
      return refused('batch_not_person')
    }
  }
  // 8 (liveness), evaluated lazily; an expiry found here is recorded.
  if (!isExecutorLeaseLive(lease, now)) {
    if (lease.endedAt === null) await expireExecutorConversationLease(prisma, lease, now)
    return refused('lease_ended')
  }

  // The binder re-checks the person, grants, revision and scope; the agent
  // still sitting in this room is the one launch-time check it does not own.
  const [agentBinding, predecessorRun] = await Promise.all([
    prisma.agentBinding.findFirst({
      where: { agentId: run.agentId, channelId: run.thread.channelId },
      select: { id: true },
    }),
    prisma.executorBinding.findFirst({
      where: { leaseId: lease.id },
      orderBy: { createdAt: 'desc' },
      select: { runId: true },
    }),
  ])
  if (!agentBinding) return refused('executor_unavailable')
  try {
    const pinned = await bindPinnedExecutorLocalApps(prisma, {
      actorContext: job.actorContext,
      actorUserId: lease.actorUserId,
      agentId: run.agentId,
      executorId: lease.executorId,
      runId,
    }, async (tx, bindings) => {
      // The binder holds the executor lock: every transition that ends a
      // lease takes it too, so this read cannot miss one that just committed.
      const current = await tx.executorConversationLease.findUnique({
        where: { id: lease.id },
        select: { absoluteExpiresAt: true, endedAt: true, idleExpiresAt: true },
      })
      if (!current || !isExecutorLeaseLive(current, now)) throw new LeaseEndedDuringCarry()
      const bindingIds = bindings.map((binding) => binding.bindingId)
      await tx.executorBinding.updateMany({ where: { id: { in: bindingIds } }, data: { leaseId: lease.id } })
      await tx.executorConversationLease.update({
        where: { id: lease.id },
        data: { idleExpiresAt: executorLeaseIdleExpiry(now), lastUsedAt: now },
      })
      await writeExecutorLeaseAudit(tx, {
        action: 'executor.run.carried',
        actor: executorLeaseAuditActor(job.actorContext),
        metadata: {
          actorUserId: lease.actorUserId,
          agentId: run.agentId,
          bindingIds,
          leaseId: lease.id,
          predecessorRunId: run.continuationOfRunId ?? run.restartOfRunId
            ?? predecessorRun?.runId ?? lease.launchRunId,
          runId,
          triggerMessageId: trigger.id,
        },
        organizationId: lease.organizationId,
        resourceId: runId,
        resourceType: 'executor_run',
      })
    }, now)
    if (pinned.kind === 'existing') return alreadyBound(prisma, runId, now)
    if (pinned.kind === 'unavailable') return refused('executor_unavailable')
    return {
      bindingIds: pinned.bindings.map((binding) => binding.bindingId),
      kind: 'carried',
      lease: summarize({ ...lease, idleExpiresAt: executorLeaseIdleExpiry(now) }, now),
    }
  } catch (error) {
    if (error instanceof LeaseEndedDuringCarry) return refused('lease_ended')
    if (!(error instanceof ExecutorError)) throw error
    // A concurrent attempt of this same job may have bound first.
    if (await prisma.executorBinding.count({ where: { runId } }) > 0) return alreadyBound(prisma, runId, now)
    return refused('executor_unavailable')
  }
}
