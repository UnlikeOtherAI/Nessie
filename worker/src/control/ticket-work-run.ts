import type { Prisma, PrismaClient } from '@prisma/client'
import {
  closeTicketWorkSessionsInTransaction,
  endTicketWork,
  enqueueTicketWorkSweep,
  writeTicketWorkThreadRow,
} from '@nessie/executor-manage'
import {
  AuthorizedActionContextSchema,
  TICKET_WORK_PURPOSE,
  TicketWorkKickoffMetadataSchema,
  withActionContext,
  type TicketWorkKickoffEvent,
} from '@nessie/schemas'

import { buildAgentActorContext, startAgentRun } from './agent-run-start.js'
import { loadTicketWorkKickoffFacts, renderTicketWorkKickoff, ticketWorkConfigOf } from './ticket-work-kickoff.js'
import type { DescribedWakeEvent } from './ticket-work-events.js'
import { claimThreadRunOrPend, lockThreadRunSlot } from '../run/thread-serialization.js'

/**
 * `queueTicketWorkRun`: one wake of a ticket's work record as a `ticket.work`
 * run in the record's own thread (docs/standards/ticket-work.md → "A
 * `ticket.work` run acts as the agent"). Called inside the transaction that
 * writes the wake's delivery, so a delivery never claims a run that did not
 * commit; the caller records a throw as a failed, retryable delivery through
 * `recordTriggerRunFailure`, exactly as `queueTriggerRun` does.
 *
 * - The run acts as the agent: `actorType: 'agent'`, no effective user,
 *   `interactive: false`, purpose `ticket.work`, and the record's id in
 *   `actionContext.ticketWorkId` for run setup to admit its ticket tools by.
 * - Its kickoff is a `system` message rebuilt from the record: why it was
 *   woken, the state, and the trigger's instructions — here, and again when
 *   its run starts (`resolveTicketWorkKickoffPrompt`), because a kickoff that
 *   pended while the ticket moved on must not tell the run a state that is
 *   gone.
 * - **Pending wakes for the same record coalesce when they are enqueued.**
 *   Under the thread's claim/drain lock, a wake for a record whose kickoff is
 *   still pending folds its event into that kickoff instead of adding a
 *   second, so the one run that drains lists every event in order and counts
 *   once against `wakesPerTicket`. Every other purpose still drains alone.
 * - **The wake limit is the platform's.** A wake that would start a run past
 *   `wakesPerTicket` starts nothing and says so; the caller stops the work.
 * - Every wake, folded or not, writes one compact thread row
 *   (`metadata.ticketWorkEvent`) naming why the agent woke.
 */

export type TicketWorkRunTarget = {
  work: { id: string; taskId: string; projectId: string; threadId: string }
  trigger: { id: string; agentId: string; organizationId: string; config: unknown }
  event: DescribedWakeEvent
  deliveryId: string
}

export type TicketWorkRunOutcome =
  | { kind: 'started' | 'pended'; messageId: string }
  | { kind: 'folded'; messageId: string }
  | { kind: 'over_limit'; wakesUsed: number; limit: number }

/** A thread row: compact, and never ticket text. The writer is executor-manage's, which a limit's stop shares. */
export { writeTicketWorkThreadRow }

/**
 * The wake limit is spent: the record fails with `limit_wakes`, its reminders
 * are cancelled with it, its coding sessions get session-scoped `work_limit`
 * closes, the pool dispatcher is enqueued for the machine it frees, and its
 * thread and ticket say how to continue. Shared by a wake that found the limit
 * spent and the sweep that finds a record over a limit a person lowered.
 */
export const stopTicketWorkAtWakeLimit = async (
  tx: Prisma.TransactionClient,
  input: {
    work: { id: string; taskId: string; triggerId: string | null; agentId: string; threadId: string }
    wakesUsed: number
  },
): Promise<boolean> => {
  const sessions = await tx.agentTicketWork.findUnique({
    where: { id: input.work.id },
    select: { executorId: true, policyId: true, sessionIds: true },
  })
  const ended = await endTicketWork(tx, { work: input.work, status: 'failed', reason: 'limit_wakes', by: 'system' })
  if (!ended) return false
  if (sessions) await closeTicketWorkSessionsInTransaction(tx, [{ ...input.work, ...sessions }], 'work_limit', null)
  await enqueueTicketWorkSweep(tx)
  await writeTicketWorkThreadRow(tx, {
    threadId: input.work.threadId,
    event: {
      kind: 'stopped',
      workId: input.work.id,
      reason: 'limit_wakes',
      summary: `${input.wakesUsed} wakes used. Move the ticket out of and back into a start-work column to continue`,
    },
  })
  return true
}

type PendingKickoff = { messageId: string; metadata: Prisma.JsonValue }

/** The kickoff still pending for this record in its thread, if there is one. */
const findPendingKickoff = async (
  tx: Prisma.TransactionClient,
  input: { agentId: string; threadId: string; workId: string },
): Promise<PendingKickoff | null> => {
  const pendings = await tx.runThreadPendingMessage.findMany({
    where: { agentId: input.agentId, threadId: input.threadId, principalUserId: null },
    orderBy: { seq: 'asc' },
    select: { messageId: true, actorContext: true, message: { select: { metadata: true } } },
  })
  for (const pending of pendings) {
    const context = AuthorizedActionContextSchema.safeParse(pending.actorContext)
    if (
      context.success
      && context.data.actionContext.purpose === TICKET_WORK_PURPOSE
      && context.data.actionContext.ticketWorkId === input.workId
    ) {
      return { messageId: pending.messageId, metadata: pending.message.metadata }
    }
  }
  return null
}

const kickoffEvents = (metadata: Prisma.JsonValue): TicketWorkKickoffEvent[] => {
  const record = metadata && typeof metadata === 'object' && !Array.isArray(metadata) ? metadata : {}
  const parsed = TicketWorkKickoffMetadataSchema.safeParse((record as Record<string, unknown>)['ticketWorkKickoff'])
  return parsed.success ? parsed.data.events : []
}

const kickoffEvent = (event: DescribedWakeEvent): TicketWorkKickoffEvent => ({
  reason: event.reason,
  at: event.at,
  text: event.text,
  ...(event.source ? { source: event.source } : {}),
  ...(event.by ? { by: event.by } : {}),
})

/**
 * A kickoff as its run starts: rendered again from the record and its trigger
 * as they are now — the work may have ended, parked or resumed while the wake
 * waited behind another run — and written back, so the thread keeps what the
 * run was told. Null for any message that is not a kickoff of this agent's
 * work in this thread, which then runs on its own content.
 */
export const rerenderTicketWorkKickoff = async (
  prisma: PrismaClient | Prisma.TransactionClient,
  input: { messageId: string; metadata: Prisma.JsonValue | null; agentId: string; threadId: string },
): Promise<string | null> => {
  const record = input.metadata && typeof input.metadata === 'object' && !Array.isArray(input.metadata)
    ? input.metadata as Record<string, unknown>
    : {}
  const kickoff = TicketWorkKickoffMetadataSchema.safeParse(record['ticketWorkKickoff'])
  if (!kickoff.success) return null
  const work = await prisma.agentTicketWork.findFirst({
    where: { id: kickoff.data.workId, agentId: input.agentId, threadId: input.threadId },
    select: { wakeCount: true, trigger: { select: { config: true } } },
  })
  if (!work) return null
  const facts = await loadTicketWorkKickoffFacts(prisma, {
    workId: kickoff.data.workId,
    wakeNumber: kickoff.data.wakeNumber ?? work.wakeCount,
    trigger: { config: work.trigger?.config ?? null },
  })
  const content = renderTicketWorkKickoff(facts, kickoff.data.events)
  await prisma.message.update({ where: { id: input.messageId }, data: { content } })
  return content
}

export const queueTicketWorkRun = async (
  tx: Prisma.TransactionClient,
  input: TicketWorkRunTarget,
): Promise<TicketWorkRunOutcome> => {
  const { work, trigger } = input
  // The claim/drain lock first: the record's wake count and its pending
  // kickoff are then read consistently with every other wake and drain.
  await lockThreadRunSlot(tx, { agentId: trigger.agentId, threadId: work.threadId })
  const record = await tx.agentTicketWork.findUniqueOrThrow({
    where: { id: work.id },
    select: { wakeCount: true },
  })
  const limit = ticketWorkConfigOf(trigger.config).limits.wakesPerTicket
  const touch = { lastWakeAt: new Date(), lastWakeReason: input.event.reason }
  const row = () => writeTicketWorkThreadRow(tx, {
    threadId: work.threadId,
    event: { kind: 'woken', workId: work.id, reason: input.event.reason, summary: input.event.summary },
  })

  const pending = await findPendingKickoff(tx, { agentId: trigger.agentId, threadId: work.threadId, workId: work.id })
  if (pending) {
    const events = [...kickoffEvents(pending.metadata), kickoffEvent(input.event)]
    const facts = await loadTicketWorkKickoffFacts(tx, { workId: work.id, wakeNumber: record.wakeCount, trigger })
    await tx.message.update({
      where: { id: pending.messageId },
      data: {
        content: renderTicketWorkKickoff(facts, events),
        metadata: {
          ticketWorkKickoff: { workId: work.id, events, wakeNumber: record.wakeCount },
        } as Prisma.InputJsonValue,
      },
    })
    await tx.agentTicketWork.update({ where: { id: work.id }, data: touch })
    await row()
    return { kind: 'folded', messageId: pending.messageId }
  }

  if (record.wakeCount >= limit) return { kind: 'over_limit', wakesUsed: record.wakeCount, limit }
  const wakeNumber = record.wakeCount + 1
  await tx.agentTicketWork.update({ where: { id: work.id }, data: { ...touch, wakeCount: wakeNumber } })
  await row()
  const events = [kickoffEvent(input.event)]
  const facts = await loadTicketWorkKickoffFacts(tx, { workId: work.id, wakeNumber, trigger })
  const content = renderTicketWorkKickoff(facts, events)
  const kickoff = await tx.message.create({
    data: {
      threadId: work.threadId,
      role: 'system',
      content,
      metadata: { ticketWorkKickoff: { workId: work.id, events, wakeNumber } } as Prisma.InputJsonValue,
    },
    select: { id: true },
  })

  const thread = await tx.thread.findUniqueOrThrow({
    where: { id: work.threadId },
    select: { channelId: true, channel: { select: { teamId: true } } },
  })
  // As the agent, and never as a person: not the mover, not the trigger's
  // author, not a machine's owner (docs/standards/ticket-work.md).
  const actorContext = withActionContext(buildAgentActorContext({
    agentId: trigger.agentId,
    channelId: thread.channelId,
    effectiveUserId: null,
    organizationId: trigger.organizationId,
    projectId: work.projectId,
    source: TICKET_WORK_PURPOSE,
    teamId: thread.channel.teamId,
    threadId: work.threadId,
  }), { ticketWorkId: work.id })

  const claim = await claimThreadRunOrPend(tx, {
    agentId: trigger.agentId,
    threadId: work.threadId,
    pending: {
      actorContext,
      channelId: thread.channelId,
      interactive: false,
      messageId: kickoff.id,
      replyPlacement: 'channel',
      triggerId: trigger.id,
      triggerDeliveryId: input.deliveryId,
    },
  })
  if (claim === 'claimed') {
    await startAgentRun(tx, {
      actorContext,
      agentId: trigger.agentId,
      channelId: thread.channelId,
      messageId: kickoff.id,
      organizationId: trigger.organizationId,
      purpose: `Ticket work (${input.event.reason})${facts.ticket.title ? `: ${facts.ticket.title}` : ''}`,
      threadId: work.threadId,
      triggerDeliveryId: input.deliveryId,
      triggerId: trigger.id,
    })
  }
  return { kind: claim === 'claimed' ? 'started' : 'pended', messageId: kickoff.id }
}
