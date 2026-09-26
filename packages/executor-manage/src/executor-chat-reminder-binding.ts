import type { Prisma, PrismaClient } from '@prisma/client'
import { AGENT_REMINDER_PURPOSE, AuthorizedActionContextSchema, type RunExecuteJobPayload } from '@nessie/schemas'

import { resolveExecutorAvailabilityCandidates } from './executor-availability-resolution.js'
import { bindExecutorCandidateBundleInTransaction } from './executor-binding.js'
import { executorCandidateHandleDigest } from './executor-candidate-handle.js'
import { EXECUTOR_LOCAL_APPS_OPERATION_KEYS } from './executor-conversation-lease.js'
import { ExecutorError } from './executor-errors.js'

/** Shared by setup and the command fence: a private-chat reminder's authority
 * comes from its stored creating run, never from the reminder text or model.
 */
export const resolveChatReminderMachines = async (
  prisma: PrismaClient | Prisma.TransactionClient,
  runId: string,
) => {
  const run = await prisma.run.findUnique({
    where: { id: runId },
    select: {
      agentId: true, threadId: true,
      triggerMessage: { select: { id: true, role: true, userId: true, deletedAt: true, metadata: true } },
      thread: { select: { channel: { select: {
        type: true, organizationId: true, members: { select: { userId: true }, take: 2 },
      } } } },
    },
  })
  if (!run) return null
  const message = run.triggerMessage
  const channel = run.thread.channel
  if (!message || message.role !== 'system' || message.userId || message.deletedAt
    || channel.type !== 'dm' || channel.members.length !== 1) return null
  const metadata = message.metadata as { agentReminder?: { reminderId?: unknown } } | null
  const reminderId = metadata?.agentReminder?.reminderId
  if (typeof reminderId !== 'string') return null
  const reminder = await prisma.agentReminder.findFirst({
    where: { id: reminderId, agentId: run.agentId, threadId: run.threadId, status: 'fired', workId: null },
    select: { createdByRun: { select: {
      id: true, agentId: true, threadId: true, status: true,
      executorBindings: { where: { leaseId: null, standingPolicyId: null, ticketWorkId: null },
        select: { executorId: true, candidateHandleDigest: true, operationKey: true } },
    } } },
  })
  const source = reminder?.createdByRun
  if (!source || source.status !== 'completed' || source.agentId !== run.agentId
    || source.threadId !== run.threadId) return null
  const userId = channel.members[0]!.userId
  // Consumed candidates are durable provenance for the original human and run.
  // A reminder can never choose a different person or a newly assigned machine.
  const provenance = await prisma.executorAvailabilityCandidate.findMany({
    where: {
      handleDigest: { in: source.executorBindings.map((binding) => binding.candidateHandleDigest) },
      actorUserId: userId, agentId: run.agentId, runId: source.id, consumedAt: { not: null },
    },
    select: { executorId: true, handleDigest: true },
  })
  const executorIds = provenance.filter((previous) => EXECUTOR_LOCAL_APPS_OPERATION_KEYS.every((key) => (
    source.executorBindings.some((binding) => binding.executorId === previous.executorId
      && binding.candidateHandleDigest === previous.handleDigest && binding.operationKey === key)
  ))).map((previous) => previous.executorId)
  return { agentId: run.agentId, threadId: run.threadId, messageId: message.id,
    organizationId: channel.organizationId, userId, executorIds }
}

/** Continue only machines from a completed private-chat run. The wake remains
 * the agent; the original person's identity authorizes only these machines.
 */
export const bindChatReminderExecutors = async (
  prisma: PrismaClient,
  { job, runId }: { job: RunExecuteJobPayload; runId: string },
): Promise<boolean> => {
  const actor = job.actorContext
  if (job.interactive || actor.actor.actorType !== 'agent'
    || actor.actor.actorId !== job.agentId || actor.actionContext.effectiveUserId
    || actor.actionContext.purpose !== AGENT_REMINDER_PURPOSE) return false
  const origin = await resolveChatReminderMachines(prisma, runId)
  if (!origin || origin.agentId !== job.agentId || origin.threadId !== job.threadId
    || origin.messageId !== job.messageId || origin.organizationId !== actor.tenant.organizationId
    || await prisma.executorBinding.count({ where: { runId } }) > 0) return false
  const operationKeys = [...EXECUTOR_LOCAL_APPS_OPERATION_KEYS]
  const author = AuthorizedActionContextSchema.parse({
    actor: { actorType: 'user', actorId: origin.userId },
    tenant: { organizationId: origin.organizationId },
    actionContext: { requestId: `chat-reminder:${runId}` },
  })
  let bound = false
  for (const executorId of origin.executorIds) {
    try {
      const availability = await resolveExecutorAvailabilityCandidates(prisma, author, {
        agentId: origin.agentId, executorId, operationKeys,
      })
      const candidate = availability.candidates.find((entry) => operationKeys.every((key) => (
        entry.operationKeys.includes(key)
      )))
      if (!candidate) continue
      await prisma.$transaction(async (tx) => {
        // Pin the new candidate to this continuation before consuming it, so a
        // later self-reminder has the same provenance as the original chat.
        await tx.executorAvailabilityCandidate.update({
          where: { handleDigest: executorCandidateHandleDigest(candidate.handle) }, data: { runId },
        })
        await bindExecutorCandidateBundleInTransaction(tx, {
          actorUserId: origin.userId, candidateHandle: candidate.handle, operationKeys, runId,
          systemKickoff: { messageId: origin.messageId },
        })
      })
      bound = true
    } catch (error) {
      if (!(error instanceof ExecutorError)) throw error
    }
  }
  return bound
}
