import type { PrismaClient } from '@prisma/client'
import {
  TICKET_WORK_LIVE_STATUSES,
  TICKET_WORK_STEER_METADATA_KEY,
  TicketChangedStoredConfigSchema,
  type TicketWorkThreadMessageJobPayload,
} from '@nessie/schemas'
import { canMemberEditProjectBoards } from '@nessie/team-admin'

import { originRuleRefusal } from './ticket-trigger-decision.js'
import { settleTicketDelivery, type SettledDecision } from './ticket-trigger-settle.js'
import { createTicketWorkSeam } from './ticket-work.js'
import type { TicketWorkSeam } from './ticket-work-seam.js'
import type { RetryContext } from './trigger-run.js'

/**
 * `ticket-work.thread-message`: a person's message in a ticket's work thread,
 * decided as a `thread_message` follow of the thread's live work record
 * (docs/standards/ticket-work.md → "The work thread").
 *
 * The message route already refused anyone who cannot edit the board and
 * started no ordinary run for it. Here the origin rule is asked again, when
 * the wake is decided — the same rule every other follow obeys — and the
 * decision is one delivery row, deduped on `thread:<triggerId>:<messageId>`,
 * beside what the work seam did. A trigger that does not follow thread
 * messages ignores it, and a thread whose work has ended wakes nothing: the
 * message stays in the thread, where the next wake's run reads it.
 */

type Options = {
  seam?: TicketWorkSeam
  retry?: RetryContext & { triggerId: string }
}

const settleStaleRetry = async (prisma: PrismaClient, retry: Options['retry']): Promise<void> => {
  if (!retry?.reuseDeliveryId) return
  await prisma.agentTriggerDelivery.updateMany({
    where: { id: retry.reuseDeliveryId, status: 'failed' },
    data: { status: 'skipped', errorMessage: 'no_longer_applies', nextRetryAt: null },
  })
}

const isSteer = (metadata: unknown): boolean =>
  typeof metadata === 'object' && metadata !== null && !Array.isArray(metadata)
  && (metadata as Record<string, unknown>)[TICKET_WORK_STEER_METADATA_KEY] === true

export const dispatchTicketThreadMessage = async (
  prisma: PrismaClient,
  job: TicketWorkThreadMessageJobPayload,
  options: Options = {},
): Promise<void> => {
  const message = await prisma.message.findUnique({
    where: { id: job.messageId },
    select: {
      id: true,
      threadId: true,
      userId: true,
      role: true,
      metadata: true,
      createdAt: true,
      deletedAt: true,
      thread: { select: { channel: { select: { organizationId: true } } } },
    },
  })
  const work = message && message.role === 'user' && message.userId && !message.deletedAt
    && message.thread.channel.organizationId === job.organizationId && isSteer(message.metadata)
    ? await prisma.agentTicketWork.findFirst({
        where: { threadId: message.threadId, status: { in: [...TICKET_WORK_LIVE_STATUSES] } },
        select: {
          id: true,
          taskId: true,
          projectId: true,
          trigger: {
            select: { id: true, agentId: true, config: true, targetChannelId: true, enabled: true, status: true },
          },
        },
      })
    : null
  const trigger = work?.trigger
  const config = TicketChangedStoredConfigSchema.safeParse(trigger?.config)
  if (
    !message?.userId || !work || !trigger?.agentId || !trigger.enabled || trigger.status !== 'active'
    || (options.retry && options.retry.triggerId !== trigger.id)
    || !config.success || !config.data.follow.kinds.includes('thread_message')
  ) {
    await settleStaleRetry(prisma, options.retry)
    return
  }

  const authorCanEditBoard = await canMemberEditProjectBoards(prisma, {
    organizationId: job.organizationId,
    userId: message.userId,
    projectId: work.projectId,
  })
  const refusal = originRuleRefusal({ origin: { kind: 'session' }, authorCanEditBoard }, { admitSource: false })
  const decision: SettledDecision = refusal
    ? { kind: 'skip', source: 'follow', reason: refusal }
    : { kind: 'follow', source: 'follow', workId: work.id, wakeReason: 'thread_message', untrusted: false }
  const seam = options.seam ?? createTicketWorkSeam(prisma)
  const task = { id: work.taskId, projectId: work.projectId }
  await settleTicketDelivery(prisma, {
    triggerId: trigger.id,
    dedupeKey: `thread:${trigger.id}:${message.id}`,
    base: { messageId: message.id, taskId: work.taskId, eventType: 'thread_message', originKind: 'session' },
    decision,
    ...(decision.kind === 'skip'
      ? {}
      : {
          act: (tx, deliveryId) => seam.wakeTicketWork(tx, {
            trigger: {
              id: trigger.id,
              agentId: trigger.agentId!,
              organizationId: job.organizationId,
              targetChannelId: trigger.targetChannelId,
              config: config.data,
            },
            task,
            event: { id: message.id, eventType: 'thread_message', createdAt: message.createdAt, kind: 'thread_message' },
            workId: work.id,
            reason: 'thread_message',
            untrusted: false,
            machineLess: false,
            resumes: false,
            deliveryId,
          }),
        }),
    ...(options.retry ? { retry: options.retry } : {}),
  })
}
