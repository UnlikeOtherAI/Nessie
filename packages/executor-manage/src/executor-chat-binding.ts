import type { PrismaClient } from '@prisma/client'
import { isPersonAuthoredMessageMetadata, type RunExecuteJobPayload } from '@nessie/schemas'

import { resolveExecutorAvailabilityCandidates } from './executor-availability-resolution.js'
import { bindExecutorCandidateBundleInTransaction } from './executor-binding.js'
import { EXECUTOR_LOCAL_APPS_OPERATION_KEYS } from './executor-conversation-lease.js'
import { ExecutorError } from './executor-errors.js'

/** Direct agent assignment is sufficient on the person's live private chat turn.
 * Availability and dispatch retain the same live access and machine checks as
 * an explicit launch. Shared rooms and unattended work keep their own paths.
 */
export const bindChatExecutors = async (
  prisma: PrismaClient,
  input: { job: RunExecuteJobPayload; runId: string },
): Promise<boolean> => {
  const { job, runId } = input
  const actor = job.actorContext
  if (!job.interactive || actor.actor.actorType !== 'user'
    || actor.actionContext.purpose === 'channel.policy'
    || (actor.actionContext.effectiveUserId && actor.actionContext.effectiveUserId !== actor.actor.actorId)) {
    return false
  }
  const userId = actor.actor.actorId
  const run = await prisma.run.findUnique({
    where: { id: runId },
    select: {
      agentId: true, threadId: true, continuationOfRunId: true,
      triggerMessage: { select: { id: true, userId: true, role: true, deletedAt: true, metadata: true } },
      thread: { select: { channel: { select: {
        type: true, organizationId: true,
        members: { select: { userId: true }, take: 2 },
      } } } },
      _count: { select: { executorBindings: true } },
    },
  })
  if (!run || run._count.executorBindings > 0) return false
  const message = run.triggerMessage
  const ownMessage = (entry: typeof message): boolean => Boolean(entry
    && entry.userId === userId && entry.role === 'user' && !entry.deletedAt
    && isPersonAuthoredMessageMetadata(entry.metadata))
  if (run.thread.channel.type !== 'dm' || run.thread.channel.members.length !== 1
    || run.thread.channel.members[0]?.userId !== userId
    || run.thread.channel.organizationId !== actor.tenant.organizationId
    || !ownMessage(message)
    || (run.continuationOfRunId && job.resumedByUserId !== userId)) return false
  if (job.batchMessageIds?.length) {
    const batch = await prisma.message.findMany({
      where: { id: { in: job.batchMessageIds }, threadId: run.threadId },
      select: { id: true, userId: true, role: true, deletedAt: true, metadata: true },
    })
    if (batch.length !== new Set(job.batchMessageIds).size || !batch.every(ownMessage)) return false
  }
  const operationKeys = [...EXECUTOR_LOCAL_APPS_OPERATION_KEYS]
  const availability = await resolveExecutorAvailabilityCandidates(prisma, actor, {
    agentId: run.agentId, operationKeys, runId,
  })
  let bound = false
  for (const candidate of availability.candidates) {
    if (!operationKeys.every((key) => candidate.operationKeys.includes(key))) continue
    try {
      await prisma.$transaction((tx) => bindExecutorCandidateBundleInTransaction(tx, {
        actorUserId: userId, candidateHandle: candidate.handle, operationKeys, runId,
      }))
      bound = true
    } catch (error) {
      // A disconnect or access removal between discovery and binding affects
      // this machine alone. Never turn a stale choice into a grant.
      if (!(error instanceof ExecutorError)) throw error
    }
  }
  return bound
}
