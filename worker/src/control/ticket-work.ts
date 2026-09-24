import { Prisma, type PrismaClient } from '@prisma/client'
import {
  closeTicketWorkQuestion,
  closeTicketWorkSessionsInTransaction,
  endTicketWork,
  enqueueTicketWorkSweep,
  recordTicketWorkActivity,
} from '@nessie/executor-manage'
import { TICKET_WORK_LIVE_STATUSES } from '@nessie/schemas'
import { ensureTicketWorkThread, lockTicketColumn, lockTicketForWork, ticketWorkThreadTitle } from '@nessie/team-admin'

import { endColumnIds } from './ticket-trigger-decision.js'
import { describeWakeEvent, type WakeEventSource } from './ticket-work-events.js'
import { ticketWorkConfigOf } from './ticket-work-kickoff.js'
import { holdTicketWorkBeforeWake, placeTicketWorkForWake } from './ticket-work-machine.js'
import {
  loadDetailSeen,
  queueTicketWorkRun,
  stopTicketWorkAtWakeLimit,
  writeTicketWorkThreadRow,
} from './ticket-work-run.js'
import type {
  TicketWorkSeam,
  TicketWorkSeamOutcome,
  TicketWorkStartInput,
  TicketWorkTrigger,
  TicketWorkWakeInput,
} from './ticket-work-seam.js'
import { TriggerLaunchOriginError } from './trigger-origin.js'
import { lockThreadRunSlot } from '../run/thread-serialization.js'

/**
 * The ticket work seam as the worker wires it (docs/standards/ticket-work.md):
 * a pickup creates the work record and its thread, and every later wake goes
 * through that record. Both run inside the dispatcher's delivery transaction;
 * reads of what is already committed (the event, its comment, its author) go
 * through the root client.
 *
 * A start, a resume and an end are decided against where the ticket is **now**,
 * read under the ticket's work lock (`lockTicketColumn`), never against the
 * column the event named: the move that started work may have been undone
 * before this job ran, and the undoing move's own teardown takes the same
 * lock, so one of the two always sees what the other committed.
 */

/** Each trigger's starts are counted under one lock, so two pickups cannot both take the last one. */
const lockTriggerStarts = (tx: Prisma.TransactionClient, triggerId: string) =>
  tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${`ticket-work-starts:${triggerId}`}, 0))`)

const startOfUtcDay = (at: Date): Date => new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()))

/**
 * The target channel has to be where the agent still is: live and bound, and
 * still readable by the whole project audience — public, ordinary. A trigger
 * that lost it cannot work any ticket, so this is the trigger's health, not a
 * skip — the same classified failure a scheduled trigger records.
 */
export const assertTargetChannel = async (
  tx: Pick<Prisma.TransactionClient, 'channel'>,
  trigger: Pick<TicketWorkTrigger, 'agentId' | 'targetChannelId'>,
): Promise<string> => {
  const channelId = trigger.targetChannelId
  const channel = channelId
    ? await tx.channel.findFirst({
        where: { id: channelId, deletedAt: null, archivedAt: null },
        select: {
          dmKey: true,
          systemChannelType: true,
          type: true,
          visibility: true,
          _count: { select: { agentBindings: { where: { agentId: trigger.agentId } } } },
        },
      })
    : null
  if (!channelId || !channel || channel._count.agentBindings === 0) {
    throw new TriggerLaunchOriginError('agent_channel_access_lost', 'its agent is no longer in the target channel')
  }
  if (channel.visibility !== 'public' || channel.type !== 'standard' || channel.systemChannelType || channel.dmKey) {
    throw new TriggerLaunchOriginError(
      'agent_channel_access_lost',
      'its target channel is no longer a public project channel, so not every ticket reader could open its work threads',
    )
  }
  return channelId
}

const inColumns = (columnId: string | null, columnIds: Iterable<string>): boolean =>
  columnId !== null && new Set(columnIds).has(columnId)

const startTicketWork = async (
  prisma: PrismaClient,
  tx: Prisma.TransactionClient,
  input: TicketWorkStartInput,
): Promise<TicketWorkSeamOutcome> => {
  const { trigger, task, event } = input
  // Where the ticket is now, under the lock its moves' teardown takes: a
  // ticket moved out again before this job ran starts nothing.
  if (!inColumns(await lockTicketColumn(tx, task.id), trigger.config.pickup?.columnIds ?? [])) {
    return { outcome: 'refused', reason: 'left_pickup_column' }
  }
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
      // Live work starts its hours clock with the record.
      ...(overDaily
        ? { stateReason: 'limit_daily', endedAt: new Date(), endedReason: 'limit_daily', endedBy: 'system' }
        : { clockStartedAt: new Date() }),
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
  // A machine from the policy's pool, at dispatch; or a place in its queue;
  // or no machine access yet. The one wake says which.
  const placed = await placeTicketWorkForWake(tx, {
    by: input.startedByUserId,
    event: described,
    kind: 'start',
    organizationId: trigger.organizationId,
    startedByEventId: event.kind === 'thread_message' ? null : event.id,
    work,
  })
  await queueTicketWorkRun(tx, { work: ref, trigger, event: placed, deliveryId: input.deliveryId })
  return { outcome: 'started', workId: work.id }
}

type WorkRow = {
  id: string
  taskId: string
  triggerId: string | null
  agentId: string
  projectId: string
  threadId: string
  status: string
  executorId: string | null
  policyId: string | null
  sessionIds: string[]
}

/**
 * A resume or an end, checked against where the ticket is now. A re-entry
 * resumes only while the ticket is still in a start-work column. An end wakes
 * the agent only for a record that has ended: a record the move's teardown
 * could not end (its trigger's config changed in between, say) is ended here
 * when the ticket still sits in an end column, and otherwise nothing is sent.
 */
const settleMoveAgainstColumn = async (
  tx: Prisma.TransactionClient,
  input: TicketWorkWakeInput & { work: WorkRow; live: boolean },
): Promise<TicketWorkSeamOutcome | null> => {
  if (!input.resumes && !input.machineLess) return null
  const columnId = await lockTicketColumn(tx, input.task.id)
  if (input.resumes) {
    return inColumns(columnId, input.trigger.config.pickup?.columnIds ?? [])
      ? null
      : { outcome: 'refused', reason: 'left_pickup_column' }
  }
  if (!input.live) return null
  const columns = await tx.boardColumn.findMany({
    where: { boardId: input.trigger.config.boardId },
    select: { id: true, category: true },
  })
  const ends = endColumnIds(input.trigger.config, columns)
  if (!inColumns(columnId, ends)) return { outcome: 'refused', reason: 'no_longer_applies' }
  const done = columns.find((column) => column.id === columnId)?.category === 'done'
  await closeTicketWorkSessionsInTransaction(tx, [input.work], 'ticket_left_flow', null)
  await enqueueTicketWorkSweep(tx)
  await endTicketWork(tx, {
    work: input.work,
    status: done ? 'done' : 'cancelled',
    reason: 'left_flow',
    by: input.event.by ?? 'system',
    causeEventId: input.event.id,
  })
  return null
}

/** Where the kickoff reads what woke the record. */
const wakeSource = (event: TicketWorkWakeInput['event'], trigger: TicketWorkTrigger): WakeEventSource => {
  switch (event.kind) {
    case 'thread_message':
      return { kind: 'thread_message', messageId: event.id }
    case 'reminder':
      return { kind: 'reminder', reminderId: event.id }
    case 'quiet':
      return { kind: 'quiet', quietMinutes: ticketWorkConfigOf(trigger.config).quietWakeMinutes ?? 0 }
    // A document change arrives already told, metadata only, by its dispatcher.
    case 'document':
      if (event.described) return { kind: 'described', ...event.described }
      return { kind: 'task_event', taskEventId: event.id }
    default:
      return { kind: 'task_event', taskEventId: event.id }
  }
}

const wakeTicketWork = async (
  prisma: PrismaClient,
  tx: Prisma.TransactionClient,
  input: TicketWorkWakeInput,
): Promise<TicketWorkSeamOutcome> => {
  const { trigger, event } = input
  const work = await tx.agentTicketWork.findFirst({
    where: { id: input.workId, triggerId: trigger.id, taskId: input.task.id },
    select: {
      id: true, taskId: true, triggerId: true, agentId: true, projectId: true, threadId: true, status: true,
      executorId: true, policyId: true, sessionIds: true,
    },
  })
  const live = work !== null && (TICKET_WORK_LIVE_STATUSES as readonly string[]).includes(work.status)
  // Only the end wake reaches a record that has ended.
  if (!work || (!live && !input.machineLess)) return { outcome: 'refused', reason: 'no_longer_applies' }
  // Every lock before any write, in the one order ticket work takes them:
  // the ticket (only a move's wake needs it), then the thread's run slot,
  // then the record — the order a pickup, a reminder's claim and a quiet
  // wake's claim take them too, so no two of them can wait on each other.
  if (input.resumes || input.machineLess) await lockTicketForWork(tx, input.task.id)
  await lockThreadRunSlot(tx, { agentId: work.agentId, threadId: work.threadId })
  const settled = await settleMoveAgainstColumn(tx, { ...input, work, live })
  if (settled) return settled
  await assertTargetChannel(tx, trigger)
  // A description change is told as a diff against what this agent last saw.
  const detailSeen = event.eventType === 'detail_edited' ? await loadDetailSeen(tx, work) : undefined
  const described = await describeWakeEvent(prisma, {
    detailSeen,
    organizationId: trigger.organizationId,
    projectId: work.projectId,
    taskId: work.taskId,
    reason: input.reason,
    source: wakeSource(event, trigger),
    at: event.createdAt,
    untrusted: input.untrusted,
    machineLess: input.machineLess,
  })
  // Live work over a limit stops instead of waking, and work whose machine is
  // offline waits for it without a run. A person's move back into a
  // start-work column resumes parked work on a machine — before the kickoff is
  // rendered, so the run is told where the work stands now.
  const resumed = input.resumes && work.status === 'parked'
  // A person's comment, message or move is the answer to any open question:
  // it closes, and the hours clock runs again. A reminder, a quiet wake, a
  // connected board's event and an edit to one of the ticket's documents
  // answer nothing (docs/standards/document-triggers.md).
  const personEvent = live && !input.untrusted && !input.machineLess
    && event.kind !== 'reminder' && event.kind !== 'quiet' && event.kind !== 'document'
  if (personEvent) await closeTicketWorkQuestion(tx, work.id)
  const held = live && !input.machineLess ? await holdTicketWorkBeforeWake(tx, { work }) : null
  if (held) return { outcome: 'refused', reason: held }
  // The placement moves the record — active, queued or waiting — and its
  // hours clock with it.
  const wake = resumed
    ? await placeTicketWorkForWake(tx, {
        by: event.by ?? null, causeEventId: event.id, event: described, kind: 'resume',
        organizationId: trigger.organizationId, work,
      })
    : described
  const outcome = await queueTicketWorkRun(tx, { work, trigger, event: wake, deliveryId: input.deliveryId })
  if (outcome.kind === 'over_limit') {
    if (live) await stopTicketWorkAtWakeLimit(tx, { work, wakesUsed: outcome.wakesUsed })
    return { outcome: 'refused', reason: 'limit_wakes' }
  }
  return { outcome: 'woken', workId: work.id }
}

export const createTicketWorkSeam = (prisma: PrismaClient): TicketWorkSeam => ({
  startTicketWork: (tx, input) => startTicketWork(prisma, tx, input),
  wakeTicketWork: (tx, input) => wakeTicketWork(prisma, tx, input),
})
