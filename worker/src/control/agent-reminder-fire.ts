import { Prisma, type PrismaClient } from '@prisma/client'
import {
  AGENT_REMINDER_PURPOSE,
  TICKET_WORK_LIVE_STATUSES,
  TicketChangedStoredConfigSchema,
} from '@nessie/schemas'
import { agentReminderThreadRefusal } from '@nessie/team-admin'

import { buildAgentActorContext, startAgentRun } from './agent-run-start.js'
import { settleTicketDelivery } from './ticket-trigger-settle.js'
import { createTicketWorkSeam } from './ticket-work.js'
import type { TicketWorkSeam } from './ticket-work-seam.js'
import type { RetryContext } from './trigger-run.js'
import { claimThreadRunOrPend, lockThreadRunSlot } from '../run/thread-serialization.js'

/**
 * Delivering due `check_back_in` reminders (docs/standards/ticket-work.md →
 * "Reminders, the quiet wake and the sweep"). The scheduler tick that fires
 * scheduled triggers calls `sweepDueAgentReminders` too, and each reminder is
 * claimed with `FOR UPDATE SKIP LOCKED` inside the transaction that delivers
 * it, so two workers never both fire one and a crash leaves it pending.
 *
 * - **In ticket work** it is the record's `reminder` wake through the work
 *   seam — a `ticket.work` run, counted against `wakesPerTicket`, with the
 *   record's policy re-checked at bind — and one delivery row deduped on
 *   `reminder:<id>`. A wake that throws leaves a failed, retryable delivery,
 *   which the delivery-retry poller re-attempts; the reminder itself is then
 *   fired, because the delivery owns its outcome.
 * - **Outside ticket work** it wakes the agent in the same conversation as
 *   itself: no effective user, not interactive, purpose `agent.reminder`,
 *   which drains alone. A conversation it can no longer wake in cancels it
 *   `undeliverable`.
 */

type DueReminder = { id: string; workId: string | null }

const LIVE = new Set<string>(TICKET_WORK_LIVE_STATUSES)

/** Lock one due reminder for this transaction, or learn another worker has it. */
const lockPendingReminder = async (tx: Prisma.TransactionClient, id: string): Promise<boolean> => {
  const rows = await tx.$queryRaw<{ id: string }[]>(Prisma.sql`
    SELECT id FROM agent_reminders WHERE id = ${id}::uuid AND status = 'pending' FOR UPDATE SKIP LOCKED`)
  return rows.length > 0
}

const markFired = (tx: Pick<Prisma.TransactionClient, 'agentReminder'>, id: string, at: Date) =>
  tx.agentReminder.updateMany({ where: { id, status: 'pending' }, data: { status: 'fired', firedAt: at } })

/**
 * The prompt a conversation reminder wakes with. The note is the agent's own
 * words, handed back to it.
 */
const conversationKickoff = (reminder: { note: string; createdAt: Date; dueAt: Date }, now: Date): string => {
  const at = (date: Date) => `${date.toISOString().slice(0, 16).replace('T', ' ')} UTC`
  const minutes = Math.round((reminder.dueAt.getTime() - reminder.createdAt.getTime()) / 60_000)
  return [
    `You asked at ${at(reminder.createdAt)} to check back in this conversation after ${minutes} minutes, `
      + `and it is now ${at(now)}. Your note: ${JSON.stringify(reminder.note)}.`,
    'Nobody is behind this run: you act as yourself, and nothing needs a person\'s answer right now. Check what '
      + 'you were waiting for, and say here what the people in this conversation should know. If it is still not '
      + 'ready, you may call check_back_in again.',
  ].join('\n')
}

const fireConversationReminder = async (prisma: PrismaClient, id: string, now: Date): Promise<void> => {
  await prisma.$transaction(async (tx) => {
    if (!(await lockPendingReminder(tx, id))) return
    const reminder = await tx.agentReminder.findUniqueOrThrow({
      where: { id },
      select: { agentId: true, threadId: true, note: true, createdAt: true, dueAt: true },
    })
    const refusal = await agentReminderThreadRefusal(tx, reminder)
    if (refusal) {
      await tx.agentReminder.update({ where: { id }, data: { status: 'cancelled', cancelledReason: 'undeliverable' } })
      return
    }
    await markFired(tx, id, now)
    const thread = await tx.thread.findUniqueOrThrow({
      where: { id: reminder.threadId },
      select: { channelId: true, channel: { select: { organizationId: true, teamId: true, projectId: true } } },
    })
    const kickoff = await tx.message.create({
      data: {
        threadId: reminder.threadId,
        role: 'system',
        content: conversationKickoff(reminder, now),
        metadata: { agentReminder: { reminderId: id } } as Prisma.InputJsonValue,
      },
      select: { id: true },
    })
    // As the agent, with nobody behind it: whoever was talking when the
    // reminder was set is not asking now, so their identity is never re-armed.
    // Machine setup may recheck assignments inherited from a completed private
    // chat run; that narrow continuation does not change this actor context.
    const actorContext = buildAgentActorContext({
      agentId: reminder.agentId,
      channelId: thread.channelId,
      effectiveUserId: null,
      organizationId: thread.channel.organizationId,
      projectId: thread.channel.projectId,
      source: AGENT_REMINDER_PURPOSE,
      teamId: thread.channel.teamId,
      threadId: reminder.threadId,
    })
    const claim = await claimThreadRunOrPend(tx, {
      agentId: reminder.agentId,
      threadId: reminder.threadId,
      pending: {
        actorContext,
        channelId: thread.channelId,
        interactive: false,
        messageId: kickoff.id,
        replyPlacement: 'channel',
      },
    })
    if (claim === 'claimed') {
      await startAgentRun(tx, {
        actorContext,
        agentId: reminder.agentId,
        channelId: thread.channelId,
        messageId: kickoff.id,
        organizationId: thread.channel.organizationId,
        purpose: `Reminder: ${reminder.note}`,
        threadId: reminder.threadId,
      })
    }
  })
}

type TicketReminderOptions = { seam?: TicketWorkSeam; retry?: RetryContext; now?: Date }

/**
 * A ticket work reminder as the record's `reminder` wake. Also the
 * delivery-retry poller's arm for a failed reminder delivery, which reuses its
 * row and claims nothing: the reminder already fired.
 */
export const fireTicketWorkReminder = async (
  prisma: PrismaClient,
  reminderId: string,
  options: TicketReminderOptions = {},
): Promise<void> => {
  const now = options.now ?? new Date()
  const reminder = await prisma.agentReminder.findUnique({
    where: { id: reminderId },
    select: {
      id: true,
      dueAt: true,
      work: {
        select: {
          id: true,
          taskId: true,
          projectId: true,
          threadId: true,
          status: true,
          organizationId: true,
          trigger: { select: { id: true, agentId: true, config: true, targetChannelId: true } },
        },
      },
    },
  })
  const work = reminder?.work
  const trigger = work?.trigger
  const live = work !== null && work !== undefined && LIVE.has(work.status)
  const parked = work?.status === 'parked'
  if (!reminder || !work || !trigger?.agentId || !live || parked) {
    // Ended work cancels its reminders in the transaction that ends it, and
    // parked work in the move that parks it; a record that lost its trigger
    // ended first. Nothing is left to wake: parked work waits for people.
    await prisma.agentReminder.updateMany({
      where: { id: reminderId, status: 'pending' },
      data: { status: 'cancelled', cancelledReason: parked ? 'work_parked' : 'work_ended' },
    })
    if (options.retry?.reuseDeliveryId) {
      await prisma.agentTriggerDelivery.updateMany({
        where: { id: options.retry.reuseDeliveryId, status: 'failed' },
        data: { status: 'skipped', errorMessage: 'no_longer_applies', nextRetryAt: null },
      })
    }
    return
  }
  const config = TicketChangedStoredConfigSchema.safeParse(trigger.config)
  const seam = options.seam ?? createTicketWorkSeam(prisma)
  const agentId = trigger.agentId
  await settleTicketDelivery(prisma, {
    triggerId: trigger.id,
    dedupeKey: `reminder:${reminder.id}`,
    base: { reminderId: reminder.id, taskId: work.taskId, eventType: 'reminder', originKind: 'system' },
    decision: config.success
      ? { kind: 'follow', source: 'reminder', workId: work.id, wakeReason: 'reminder', untrusted: false }
      : { kind: 'skip', source: 'reminder', reason: 'config_invalid' },
    ...(options.retry
      ? { retry: options.retry }
      : {
          // In the order every wake of the record takes its locks — the
          // thread's run slot, then the record — and only then the reminder,
          // after the record as a move's teardown takes them: no cycle.
          claim: async (tx) => {
            await lockThreadRunSlot(tx, { agentId, threadId: work.threadId })
            await tx.$queryRaw(Prisma.sql`SELECT id FROM agent_ticket_work WHERE id = ${work.id}::uuid FOR UPDATE`)
            return (await lockPendingReminder(tx, reminder.id)) && (await markFired(tx, reminder.id, now)).count > 0
          },
        }),
    ...(config.success
      ? {
          act: (tx, deliveryId) => seam.wakeTicketWork(tx, {
            trigger: {
              id: trigger.id,
              agentId,
              organizationId: work.organizationId,
              targetChannelId: trigger.targetChannelId,
              config: config.data,
            },
            task: { id: work.taskId, projectId: work.projectId },
            event: { id: reminder.id, eventType: 'reminder', createdAt: reminder.dueAt, kind: 'reminder' },
            workId: work.id,
            reason: 'reminder',
            untrusted: false,
            machineLess: false,
            resumes: false,
            deliveryId,
          }),
        }
      : {}),
  })
  // A wake that threw left a failed, retryable delivery and rolled the claim
  // back: the delivery now owns the outcome, so the reminder is spent.
  await markFired(prisma, reminder.id, now)
}

/**
 * The scheduler tick's reminders: every pending reminder that is due, oldest
 * first — except a ticket reminder whose delivery already exists, which the
 * delivery-retry poller owns.
 */
export const sweepDueAgentReminders = async (
  prisma: PrismaClient,
  input: { limit: number; now?: Date; seam?: TicketWorkSeam },
): Promise<void> => {
  const now = input.now ?? new Date()
  const due = await prisma.$queryRaw<DueReminder[]>(Prisma.sql`
    SELECT r.id, r.work_id AS "workId"
    FROM agent_reminders r
    LEFT JOIN agent_ticket_work w ON w.id = r.work_id
    WHERE r.status = 'pending'
      AND r.due_at <= ${now}
      AND NOT EXISTS (
        SELECT 1 FROM agent_trigger_deliveries d
        WHERE d.trigger_id = w.trigger_id AND d.dedupe_key = 'reminder:' || r.id::text
      )
    ORDER BY r.due_at ASC
    LIMIT ${input.limit}
  `)
  for (const reminder of due) {
    try {
      if (reminder.workId) {
        await fireTicketWorkReminder(prisma, reminder.id, { now, ...(input.seam ? { seam: input.seam } : {}) })
      } else {
        await fireConversationReminder(prisma, reminder.id, now)
      }
    } catch (error) {
      // One reminder that throws never stalls the rest; it stays pending and
      // the next tick tries it again.
      console.error('[worker.reminder-sweep] fire failed', JSON.stringify({ reminderId: reminder.id }), error)
    }
  }
}
