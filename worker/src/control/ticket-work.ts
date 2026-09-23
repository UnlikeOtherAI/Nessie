import { Prisma, type PrismaClient } from '@prisma/client'
import { TICKET_WORK_LIVE_STATUSES } from '@nessie/schemas'
import {
  endTicketWork,
  ensureTicketWorkThread,
  recordTicketWorkActivity,
  ticketWorkThreadTitle,
} from '@nessie/team-admin'

import { describeWakeEvent } from './ticket-work-events.js'
import { ticketWorkConfigOf } from './ticket-work-kickoff.js'
import { queueTicketWorkRun, writeTicketWorkThreadRow } from './ticket-work-run.js'
import type {
  TicketWorkSeam,
  TicketWorkSeamOutcome,
  TicketWorkStartInput,
  TicketWorkTrigger,
  TicketWorkWakeInput,
} from './ticket-work-seam.js'
import { TriggerLaunchOriginError } from './trigger-origin.js'

/**
 * The ticket work seam as the worker wires it (docs/standards/ticket-work.md):
 * a pickup creates the work record and its thread, and every later wake goes
 * through that record. Both run inside the dispatcher's delivery transaction;
 * reads of what is already committed (the event, its comment, its author) go
 * through the root client.
 */

/** Each trigger's starts are counted under one lock, so two pickups cannot both take the last one. */
const lockTriggerStarts = (tx: Prisma.TransactionClient, triggerId: string) =>
  tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${`ticket-work-starts:${triggerId}`}, 0))`)

const startOfUtcDay = (at: Date): Date => new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()))

/**
 * The target channel has to be where the agent still is: live and bound. A
 * trigger that lost it cannot work any ticket, so this is the trigger's health,
 * not a skip — the same classified failure a scheduled trigger records.
 */
const assertTargetChannel = async (tx: Prisma.TransactionClient, trigger: TicketWorkTrigger): Promise<string> => {
  const channelId = trigger.targetChannelId
  const bound = channelId
    ? await tx.agentBinding.count({
        where: { agentId: trigger.agentId, channel: { id: channelId, deletedAt: null, archivedAt: null } },
      })
    : 0
  if (!channelId || bound === 0) {
    throw new TriggerLaunchOriginError('agent_channel_access_lost', 'its agent is no longer in the target channel')
  }
  return channelId
}

const startTicketWork = async (
  prisma: PrismaClient,
  tx: Prisma.TransactionClient,
  input: TicketWorkStartInput,
): Promise<TicketWorkSeamOutcome> => {
  const { trigger, task, event } = input
  const channelId = await assertTargetChannel(tx, trigger)
  await lockTriggerStarts(tx, trigger.id)
  const live = await tx.agentTicketWork.count({
    where: { triggerId: trigger.id, taskId: task.id, status: { in: [...TICKET_WORK_LIVE_STATUSES] } },
  })
  // A second pickup raced this one to the same ticket: its record is the work.
  if (live > 0) return { outcome: 'refused', reason: 'no_longer_applies' }
  const ticket = await tx.task.findUniqueOrThrow({
    where: { id: task.id },
    select: { title: true, externalLink: { select: { externalKey: true } } },
  })
  const thread = await ensureTicketWorkThread(tx, {
    triggerId: trigger.id,
    taskId: task.id,
    agentId: trigger.agentId,
    channelId,
    title: ticketWorkThreadTitle(ticket),
  })
  const startedToday = await tx.agentTicketWork.count({
    where: {
      triggerId: trigger.id,
      startedAt: { gte: startOfUtcDay(new Date()) },
      // A pickup refused by this limit never started. (`NOT` alone would also
      // drop every record with no end reason: SQL's NULL is not "not equal".)
      OR: [{ endedReason: null }, { endedReason: { not: 'limit_daily' } }],
    },
  })
  const { startsPerDay } = ticketWorkConfigOf(trigger.config).limits
  const overDaily = startedToday >= startsPerDay
  const work = await tx.agentTicketWork.create({
    data: {
      organizationId: trigger.organizationId,
      triggerId: trigger.id,
      agentId: trigger.agentId,
      taskId: task.id,
      projectId: task.projectId,
      threadId: thread.id,
      startedByUserId: input.startedByUserId,
      startedByEventId: event.kind === 'thread_message' ? null : event.id,
      // Recorded, then stopped at once when the day's starts are used up: the
      // ticket and its thread say why nothing started.
      status: overDaily ? 'failed' : 'active',
      ...(overDaily ? { stateReason: 'limit_daily', endedAt: new Date(), endedReason: 'limit_daily', endedBy: 'system' } : {}),
    },
    select: { id: true, taskId: true, triggerId: true, agentId: true },
  })
  const ref = { id: work.id, taskId: task.id, projectId: task.projectId, threadId: thread.id }
  if (overDaily) {
    await recordTicketWorkActivity(tx, { work, eventType: 'work_ended', status: 'failed', reason: 'limit_daily' })
    await writeTicketWorkThreadRow(tx, {
      threadId: thread.id,
      event: {
        kind: 'stopped',
        workId: work.id,
        reason: 'limit_daily',
        summary: `this trigger already started ${startsPerDay} tickets today, so this one did not start`,
      },
    })
    return { outcome: 'refused', reason: 'limit_starts' }
  }
  await recordTicketWorkActivity(tx, {
    work,
    eventType: 'work_started',
    status: 'active',
    reason: null,
    by: input.startedByUserId,
  })
  const described = await describeWakeEvent(prisma, {
    organizationId: trigger.organizationId,
    projectId: task.projectId,
    taskId: task.id,
    reason: 'pickup',
    source: { kind: 'task_event', taskEventId: event.id },
    at: event.createdAt,
    untrusted: false,
    machineLess: false,
  })
  await queueTicketWorkRun(tx, { work: ref, trigger, event: described, deliveryId: input.deliveryId })
  return { outcome: 'started', workId: work.id }
}

const wakeTicketWork = async (
  prisma: PrismaClient,
  tx: Prisma.TransactionClient,
  input: TicketWorkWakeInput,
): Promise<TicketWorkSeamOutcome> => {
  const { trigger, event } = input
  const work = await tx.agentTicketWork.findFirst({
    where: { id: input.workId, triggerId: trigger.id, taskId: input.task.id },
    select: { id: true, taskId: true, triggerId: true, agentId: true, projectId: true, threadId: true, status: true },
  })
  const live = work !== null && (TICKET_WORK_LIVE_STATUSES as readonly string[]).includes(work.status)
  // Only the end wake reaches a record that has ended: teardown ran in the move.
  if (!work || (!live && !input.machineLess)) return { outcome: 'refused', reason: 'no_longer_applies' }
  await assertTargetChannel(tx, trigger)
  const described = await describeWakeEvent(prisma, {
    organizationId: trigger.organizationId,
    projectId: work.projectId,
    taskId: work.taskId,
    reason: input.reason,
    source: event.kind === 'thread_message'
      ? { kind: 'thread_message', messageId: event.id }
      : { kind: 'task_event', taskEventId: event.id },
    at: event.createdAt,
    untrusted: input.untrusted,
    machineLess: input.machineLess,
  })
  const outcome = await queueTicketWorkRun(tx, { work, trigger, event: described, deliveryId: input.deliveryId })
  if (outcome.kind === 'over_limit') {
    if (live) {
      await endTicketWork(tx, { work, status: 'failed', reason: 'limit_wakes', by: 'system' })
      await writeTicketWorkThreadRow(tx, {
        threadId: work.threadId,
        event: {
          kind: 'stopped',
          workId: work.id,
          reason: 'limit_wakes',
          summary: `${outcome.wakesUsed} wakes used. Move the ticket out of and back into a start-work column to continue`,
        },
      })
    }
    return { outcome: 'refused', reason: 'limit_wakes' }
  }
  // A person's move back into a start-work column resumes parked work.
  if (input.resumes && work.status === 'parked') {
    await tx.agentTicketWork.update({ where: { id: work.id }, data: { status: 'active', stateReason: null } })
  }
  return { outcome: 'woken', workId: work.id }
}

export const createTicketWorkSeam = (prisma: PrismaClient): TicketWorkSeam => ({
  startTicketWork: (tx, input) => startTicketWork(prisma, tx, input),
  wakeTicketWork: (tx, input) => wakeTicketWork(prisma, tx, input),
})
