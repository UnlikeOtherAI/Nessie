import { Prisma, type PrismaClient } from '@prisma/client'
import {
  AGENT_REMINDER_CAPS,
  AGENT_REMINDER_NOTE_MAX_CHARS,
  CHECK_BACK_IN_MINUTES,
  TICKET_WORK_LIVE_STATUSES,
} from '@nessie/schemas'

import { writeTicketWorkThreadRow } from './ticket-work-thread.js'

/**
 * `check_back_in` reminders (docs/standards/ticket-work.md → "Reminders, the
 * quiet wake and the sweep"). A reminder is its own row, never a
 * `schedule_task` trigger: those run as their creator and count against their
 * schedule cap, and a reminder wakes the agent as itself.
 *
 * - **In ticket work** a record holds one pending reminder; a new one replaces
 *   it (`replaced`), under the record's row lock, so two calls racing cannot
 *   leave two. It fires as the record's `reminder` wake, and ends with it.
 * - **Outside ticket work** it wakes the agent in the same conversation with
 *   nobody behind the run. It is refused in a system conversation (a Personal
 *   Assistant, Agent Designer or other system agent's DM) and while the run
 *   speaks for a person in a shared room, because a reminder there would wake
 *   without the person the conversation belongs to — or re-arm them. At most
 *   `AGENT_REMINDER_CAPS.pendingPerThread` of the agent's reminders wait in
 *   one conversation, and it sets at most `perAgentPerDay` a UTC day.
 */

export type AgentReminderSetInput = {
  agentId: string
  threadId: string
  runId: string | null
  minutes: number
  note: string
  /** The run's own ticket work record, when it is a `ticket.work` run. */
  workId: string | null
  /** The person a Personal Assistant presence speaks for in a shared room. */
  principalUserId?: string | null
  now?: Date
}

export type AgentReminderSetResult =
  | { ok: true; reminder: { id: string; dueAt: Date; note: string }; replaced: boolean }
  | { ok: false; refusal: string }

const refuse = (refusal: string): AgentReminderSetResult => ({ ok: false, refusal })

export const CHECK_BACK_IN_RANGE_REFUSAL = (given: unknown): string =>
  `minutes must be a whole number from ${CHECK_BACK_IN_MINUTES.min} to ${CHECK_BACK_IN_MINUTES.max}; `
  + `you gave ${JSON.stringify(given)}. Pick the nearest one in range.`

const startOfUtcDay = (at: Date): Date => new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()))

const inRange = (minutes: number): boolean =>
  Number.isInteger(minutes) && minutes >= CHECK_BACK_IN_MINUTES.min && minutes <= CHECK_BACK_IN_MINUTES.max

const setTicketWorkReminder = async (
  tx: Prisma.TransactionClient,
  input: AgentReminderSetInput & { workId: string; dueAt: Date; note: string },
): Promise<AgentReminderSetResult> => {
  // The record's own row lock: a second call for the same record waits here
  // and then replaces this one's reminder, never sits beside it.
  await tx.$queryRaw(Prisma.sql`SELECT id FROM agent_ticket_work WHERE id = ${input.workId}::uuid FOR UPDATE`)
  const work = await tx.agentTicketWork.findUnique({
    where: { id: input.workId },
    select: { agentId: true, threadId: true, status: true },
  })
  if (!work || work.agentId !== input.agentId || work.threadId !== input.threadId) {
    return refuse('This run\'s ticket work is not in this conversation, so a reminder here would wake nothing.')
  }
  if (!(TICKET_WORK_LIVE_STATUSES as readonly string[]).includes(work.status)) {
    return refuse('This ticket\'s work has ended, so there is nothing to check back on.')
  }
  // Parked work waits for the people reviewing it, not for a clock.
  if (work.status === 'parked') {
    return refuse('This ticket is in review, so its work waits for people: a person moving it back into a '
      + 'start-work column wakes you. There is no need for a reminder.')
  }
  const { count } = await tx.agentReminder.updateMany({
    where: { workId: input.workId, status: 'pending' },
    data: { status: 'cancelled', cancelledReason: 'replaced' },
  })
  const reminder = await tx.agentReminder.create({
    data: {
      agentId: input.agentId,
      threadId: input.threadId,
      workId: input.workId,
      dueAt: input.dueAt,
      note: input.note,
      createdByRunId: input.runId,
    },
    select: { id: true, dueAt: true, note: true },
  })
  return { ok: true, reminder, replaced: count > 0 }
}

/**
 * Why the agent cannot be woken in this conversation with nobody behind the
 * run, or null when it can. Asked when a reminder is set and again when it
 * fires: the room may have changed in between.
 */
export const agentReminderThreadRefusal = async (
  tx: Pick<Prisma.TransactionClient, 'thread' | 'agentBinding'>,
  input: { agentId: string; threadId: string },
): Promise<string | null> => {
  const thread = await tx.thread.findUnique({
    where: { id: input.threadId },
    select: {
      channel: { select: { id: true, deletedAt: true, archivedAt: true, systemChannelType: true } },
    },
  })
  const channel = thread?.channel
  if (!channel || channel.deletedAt || channel.archivedAt) {
    return 'This conversation is gone or archived, so a reminder here would wake nobody.'
  }
  if (channel.systemChannelType) {
    return 'check_back_in is refused in a direct conversation with the Personal Assistant, the Agent Designer '
      + 'or another system agent: a reminder there would wake without the person the conversation belongs to.'
  }
  const bound = await tx.agentBinding.count({ where: { agentId: input.agentId, channelId: channel.id } })
  return bound === 0 ? 'You are no longer in this conversation\'s channel, so a reminder here would wake nothing.' : null
}

const setConversationReminder = async (
  tx: Prisma.TransactionClient,
  input: AgentReminderSetInput & { dueAt: Date; note: string; now: Date },
): Promise<AgentReminderSetResult> => {
  if (input.principalUserId) {
    return refuse('check_back_in is refused while you speak for a person in this room: '
      + 'the reminder would wake without them.')
  }
  const refusal = await agentReminderThreadRefusal(tx, input)
  if (refusal) return refuse(refusal)
  // One agent's reminders are counted under one lock, so two calls cannot
  // both take the last place.
  await tx.$executeRaw(
    Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${`agent-reminders:${input.agentId}`}, 0))`,
  )
  const [pending, today] = await Promise.all([
    tx.agentReminder.count({
      where: { agentId: input.agentId, threadId: input.threadId, workId: null, status: 'pending' },
    }),
    tx.agentReminder.count({
      where: { agentId: input.agentId, workId: null, createdAt: { gte: startOfUtcDay(input.now) } },
    }),
  ])
  if (pending >= AGENT_REMINDER_CAPS.pendingPerThread) {
    return refuse(`This conversation already holds ${pending} of your pending reminders, the most it may; `
      + 'let one fire before you set another.')
  }
  if (today >= AGENT_REMINDER_CAPS.perAgentPerDay) {
    return refuse(`You already set ${today} reminders today (UTC), the most a day allows; `
      + 'you can set another tomorrow.')
  }
  const reminder = await tx.agentReminder.create({
    data: {
      agentId: input.agentId,
      threadId: input.threadId,
      dueAt: input.dueAt,
      note: input.note,
      createdByRunId: input.runId,
    },
    select: { id: true, dueAt: true, note: true },
  })
  return { ok: true, reminder, replaced: false }
}

export const setAgentReminder = async (
  prisma: PrismaClient,
  input: AgentReminderSetInput,
): Promise<AgentReminderSetResult> => {
  if (!inRange(input.minutes)) return refuse(CHECK_BACK_IN_RANGE_REFUSAL(input.minutes))
  const note = input.note.trim()
  if (!note) return refuse('Say in a few words what you are waiting for, as note ("waiting for CI").')
  if (note.length > AGENT_REMINDER_NOTE_MAX_CHARS) {
    return refuse(`Keep note to ${AGENT_REMINDER_NOTE_MAX_CHARS} characters: it is a line on the ticket, not a plan.`)
  }
  const now = input.now ?? new Date()
  const dueAt = new Date(now.getTime() + input.minutes * 60_000)
  return prisma.$transaction((tx) => (input.workId
    ? setTicketWorkReminder(tx, { ...input, workId: input.workId, dueAt, note })
    : setConversationReminder(tx, { ...input, dueAt, note, now })))
}

/**
 * A person pressed Cancel on the ticket's chip. The caller checked that they
 * can edit the board; the reminder must be pending and belong to live work on
 * this ticket. The work thread says who cancelled it, in the same
 * transaction, so the agent's quiet is never unexplained. Returns the
 * cancelled reminder's work record, or null when nothing was pending.
 */
export const cancelTicketWorkReminder = async (
  prisma: PrismaClient,
  input: { taskId: string; reminderId: string; byUserId: string },
): Promise<{ workId: string } | null> => prisma.$transaction(async (tx) => {
  const reminder = await tx.agentReminder.findFirst({
    where: {
      id: input.reminderId,
      status: 'pending',
      work: { taskId: input.taskId, status: { in: [...TICKET_WORK_LIVE_STATUSES] } },
    },
    select: { workId: true, threadId: true },
  })
  if (!reminder?.workId) return null
  const { count } = await tx.agentReminder.updateMany({
    where: { id: input.reminderId, status: 'pending' },
    data: { status: 'cancelled', cancelledReason: 'person' },
  })
  if (count === 0) return null
  const person = await tx.user.findUnique({ where: { id: input.byUserId }, select: { displayName: true } })
  await writeTicketWorkThreadRow(tx, {
    threadId: reminder.threadId,
    event: {
      kind: 'reminder_cancelled',
      workId: reminder.workId,
      reminderId: input.reminderId,
      summary: `${person?.displayName ?? 'A person'} cancelled the agent's reminder`,
    },
  })
  return { workId: reminder.workId }
})
