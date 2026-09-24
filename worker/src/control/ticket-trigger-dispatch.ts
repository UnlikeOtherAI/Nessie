import type { PrismaClient } from '@prisma/client'
import {
  ColumnEnteredTaskEventPayloadSchema,
  CreatedTaskEventPayloadSchema,
  isTicketTriggerEventType,
  TaskEventAuthorshipSchema,
  TICKET_WORK_LIVE_STATUSES,
  TICKET_WORK_TERMINAL_STATUSES,
  TicketChangedStoredConfigSchema,
  TicketTriggerDeliveryPayloadSchema,
  TicketWorkActivityPayloadSchema,
  TicketWorkStatusSchema,
  type ColumnCategory,
  type TicketTriggerEventType,
  type TriggerTicketDispatchJobPayload,
} from '@nessie/schemas'
import { canMemberEditProjectBoards, resolveTaskHomeBoard } from '@nessie/team-admin'

import {
  decideTicketTrigger,
  type TicketEventFacts,
  type TicketWorkFacts,
} from './ticket-trigger-decision.js'
import { createTicketWorkSeam } from './ticket-work.js'
import type { TicketWorkSeam, TicketWorkTrigger } from './ticket-work-seam.js'
import {
  settleTicketDelivery,
  type DeliveryBase,
  type SeamAct,
  type SettledDecision,
} from './ticket-trigger-settle.js'
import { dispatchTicketThreadMessage } from './ticket-thread-message-dispatch.js'
import { recordTriggerHealthFailure } from './trigger-health.js'
import type { RetryContext } from './trigger-run.js'

/**
 * `trigger.ticket.dispatch`: one `TaskEvent`, decided for every
 * `ticket_changed` trigger that can see it (docs/standards/ticket-work.md).
 *
 * Triggers are found by the indexed `scope_board_id` of the board the event
 * happened on — never by loading every trigger in the organisation — plus any
 * trigger that already has live work on the ticket, which follows it even to
 * another board. Each decision is `decideTicketTrigger`'s; this file loads its
 * facts and settles it as exactly one `agent_trigger_deliveries` row, deduped
 * on `ticket:<triggerId>:<taskEventId>`, beside whatever the work seam did.
 */

export type TicketDispatchOptions = {
  seam?: TicketWorkSeam
  /** A retry of one failed delivery: only its trigger, reusing its row. */
  retry?: RetryContext & { triggerId: string }
}

type LoadedEvent = {
  id: string
  eventType: TicketTriggerEventType
  createdAt: Date
  facts: Omit<TicketEventFacts, 'authorCanEditBoard'>
  /** The author a `session` or `token` origin names: the member. */
  by: string | null
  boardId: string | null
  task: { id: string; projectId: string }
}

const readEvent = async (
  prisma: PrismaClient,
  job: TriggerTicketDispatchJobPayload,
): Promise<LoadedEvent | null> => {
  const row = await prisma.taskEvent.findUnique({
    where: { id: job.taskEventId },
    select: {
      id: true,
      eventType: true,
      payload: true,
      createdAt: true,
      task: { select: { id: true, organizationId: true, projectId: true, boardId: true } },
    },
  })
  if (!row || row.task.organizationId !== job.organizationId || !row.task.projectId) return null
  if (!isTicketTriggerEventType(row.eventType)) return null
  // An origin that does not parse is `system`: it can start and steer nothing.
  const authorship = TaskEventAuthorshipSchema.safeParse(row.payload)
  const origin = authorship.success ? authorship.data.origin : { kind: 'system' as const }
  let toColumnId: string | null = null
  let fromColumnId: string | null = null
  let boardId: string | null = null
  if (row.eventType === 'column_entered') {
    const parsed = ColumnEnteredTaskEventPayloadSchema.safeParse(row.payload)
    if (parsed.success) {
      toColumnId = parsed.data.toColumnId
      fromColumnId = parsed.data.fromColumnId
      const column = await prisma.boardColumn.findUnique({
        where: { id: toColumnId },
        select: { boardId: true },
      })
      boardId = column?.boardId ?? null
    }
  } else if (row.eventType === 'created') {
    const parsed = CreatedTaskEventPayloadSchema.safeParse(row.payload)
    if (parsed.success) {
      toColumnId = parsed.data.columnId
      boardId = parsed.data.boardId
    }
  } else {
    boardId = (await resolveTaskHomeBoard(prisma, row.task))?.id ?? null
  }
  return {
    id: row.id,
    eventType: row.eventType,
    createdAt: row.createdAt,
    facts: { eventType: row.eventType, origin, toColumnId, fromColumnId },
    by: authorship.success ? authorship.data.by ?? null : null,
    boardId,
    task: { id: row.task.id, projectId: row.task.projectId },
  }
}

/**
 * The live record, or for a column move the one this very move ended — named
 * by the `work_ended` row its teardown wrote with this event as its cause, so
 * a second move into an end column never re-announces an end an earlier move
 * (or a limit, or a disabled trigger) already caused.
 */
const readWork = async (
  prisma: PrismaClient,
  triggerId: string,
  event: LoadedEvent,
): Promise<TicketWorkFacts | null> => {
  const select = { id: true, status: true } as const
  const live = await prisma.agentTicketWork.findFirst({
    where: { triggerId, taskId: event.task.id, status: { in: [...TICKET_WORK_LIVE_STATUSES] } },
    select,
  })
  if (live) return { id: live.id, status: TicketWorkStatusSchema.parse(live.status), live: true }
  if (event.eventType !== 'column_entered') return null
  const endedBy = await prisma.taskEvent.findFirst({
    where: {
      taskId: event.task.id,
      eventType: 'work_ended',
      AND: [
        { payload: { path: ['causeEventId'], equals: event.id } },
        { payload: { path: ['triggerId'], equals: triggerId } },
      ],
    },
    select: { payload: true },
  })
  const workId = TicketWorkActivityPayloadSchema.safeParse(endedBy?.payload)
  const ended = workId.success
    ? await prisma.agentTicketWork.findFirst({
        where: { id: workId.data.workId, triggerId, status: { in: [...TICKET_WORK_TERMINAL_STATUSES] } },
        select,
      })
    : null
  return ended ? { id: ended.id, status: TicketWorkStatusSchema.parse(ended.status), live: false } : null
}

/** What the delivery says about this event, whatever was decided. */
const deliveryBase = (event: LoadedEvent): DeliveryBase => ({
  taskEventId: event.id,
  taskId: event.task.id,
  eventType: event.eventType,
  originKind: event.facts.origin.kind,
})

/** One decision on one event as one delivery row, deduped per trigger and event. */
const settle = (
  prisma: PrismaClient,
  input: {
    triggerId: string
    event: LoadedEvent
    decision: SettledDecision
    act?: SeamAct
    retry?: RetryContext
  },
): Promise<void> => settleTicketDelivery(prisma, {
  triggerId: input.triggerId,
  dedupeKey: `ticket:${input.triggerId}:${input.event.id}`,
  base: deliveryBase(input.event),
  decision: input.decision,
  ...(input.act ? { act: input.act } : {}),
  ...(input.retry ? { retry: input.retry } : {}),
})

/** The work seam's call for a start, a re-entry, a follow or an end. */
const seamCall = (
  seam: TicketWorkSeam,
  decision: SettledDecision,
  trigger: TicketWorkTrigger,
  event: LoadedEvent,
): SeamAct | undefined => {
  if (decision.kind === 'skip') return undefined
  const common = { trigger, task: event.task, event }
  if (decision.kind === 'pickup') {
    // A pickup passed the origin rule, so its author is a board editor's id.
    const startedByUserId = event.by as string
    return (tx, deliveryId) => seam.startTicketWork(tx, { ...common, startedByUserId, deliveryId })
  }
  return (tx, deliveryId) =>
    seam.wakeTicketWork(tx, {
      ...common,
      workId: decision.workId,
      reason: decision.wakeReason,
      untrusted: decision.kind === 'follow' && decision.untrusted,
      machineLess: decision.kind === 'end',
      resumes: decision.kind === 'reentry',
      deliveryId,
    })
}

const CONFIG_INVALID_DETAIL =
  'This ticket trigger names no board, or its configuration no longer parses, so it matches nothing. '
  + 'Edit it on the Triggers page and choose its board again.'

/** A retried delivery whose event now means nothing: settled, never retried again. */
const settleStaleRetry = async (
  prisma: PrismaClient,
  retry: TicketDispatchOptions['retry'],
): Promise<void> => {
  if (!retry?.reuseDeliveryId) return
  await prisma.agentTriggerDelivery.updateMany({
    where: { id: retry.reuseDeliveryId, status: 'failed' },
    data: { status: 'skipped', errorMessage: 'no_longer_applies', nextRetryAt: null },
  })
}

export const dispatchTicketEvent = async (
  prisma: PrismaClient,
  job: TriggerTicketDispatchJobPayload,
  options: TicketDispatchOptions = {},
): Promise<void> => {
  const event = await readEvent(prisma, job)
  const triggers = event
    ? await prisma.agentTrigger.findMany({
        where: {
          type: 'ticket_changed',
          enabled: true,
          status: 'active',
          agent: { organizationId: job.organizationId },
          ...(options.retry ? { id: options.retry.triggerId } : {}),
          OR: [
            ...(event.boardId ? [{ scopeBoardId: event.boardId }] : []),
            { ticketWork: { some: { taskId: event.task.id, status: { in: [...TICKET_WORK_LIVE_STATUSES] } } } },
          ],
        },
        select: { id: true, agentId: true, config: true, targetChannelId: true, scopeBoardId: true },
        orderBy: { createdAt: 'asc' },
      })
    : []
  if (!event || triggers.length === 0) {
    await settleStaleRetry(prisma, options.retry)
    return
  }

  // Asked once per event, and only of a person's own session: whether its
  // author can edit the board now, when the dispatcher decides.
  const authorCanEditBoard = event.facts.origin.kind === 'session' && event.by !== null
    && await canMemberEditProjectBoards(prisma, {
      organizationId: job.organizationId,
      userId: event.by,
      projectId: event.task.projectId,
    })
  const facts: TicketEventFacts = { ...event.facts, authorCanEditBoard }
  const columnsByBoard = new Map<string, { id: string; category: ColumnCategory }[]>()
  const seam = options.seam ?? createTicketWorkSeam(prisma)
  const retry = options.retry ? { retry: options.retry } : {}

  for (const row of triggers) {
    const config = TicketChangedStoredConfigSchema.safeParse(row.config)
    if (!row.agentId || !row.scopeBoardId || !config.success) {
      await settle(prisma, {
        triggerId: row.id,
        event,
        decision: { kind: 'skip', source: 'follow', reason: 'config_invalid' },
        ...retry,
      })
      await recordTriggerHealthFailure(prisma, {
        error: { isReauthorizable: false, message: CONFIG_INVALID_DETAIL, reason: 'ticket_trigger_config_invalid' },
        triggerId: row.id,
      })
      continue
    }
    const boardId = row.scopeBoardId
    let columns = columnsByBoard.get(boardId)
    if (!columns) {
      columns = await prisma.boardColumn.findMany({ where: { boardId }, select: { id: true, category: true } })
      columnsByBoard.set(boardId, columns)
    }
    const decision = decideTicketTrigger(
      facts,
      { agentId: row.agentId, config: config.data, columns },
      await readWork(prisma, row.id, event),
    )
    if (decision.kind === 'ignore') {
      await settleStaleRetry(prisma, options.retry)
      continue
    }
    const trigger: TicketWorkTrigger = {
      id: row.id,
      agentId: row.agentId,
      organizationId: job.organizationId,
      targetChannelId: row.targetChannelId,
      config: config.data,
    }
    const act = seamCall(seam, decision, trigger, event)
    await settle(prisma, { triggerId: row.id, event, decision, ...(act ? { act } : {}), ...retry })
  }
}

/**
 * The delivery-retry poller's arm for a ticket trigger: decide the stored
 * event again, for this trigger only, reusing the failed row. A ticket
 * trigger has no fixed thread, so the generic re-attempt cannot carry it.
 */
export const reattemptTicketTriggerDelivery = async (
  prisma: PrismaClient,
  input: {
    organizationId: string | null
    payload: unknown
    retryCount: number
    reuseDeliveryId: string
    triggerId: string
  },
  options: Pick<TicketDispatchOptions, 'seam'> = {},
): Promise<void> => {
  const parsed = TicketTriggerDeliveryPayloadSchema.safeParse(input.payload)
  if (!parsed.success || !input.organizationId) {
    await prisma.agentTriggerDelivery.update({
      where: { id: input.reuseDeliveryId },
      data: { nextRetryAt: null },
    })
    return
  }
  const retry = {
    reuseDeliveryId: input.reuseDeliveryId,
    retryCount: input.retryCount,
    triggerId: input.triggerId,
  }
  // A person's message in the work thread is decided by its own door.
  if (parsed.data.messageId) {
    await dispatchTicketThreadMessage(
      prisma,
      { organizationId: input.organizationId, messageId: parsed.data.messageId },
      { ...options, retry },
    )
    return
  }
  await dispatchTicketEvent(
    prisma,
    { organizationId: input.organizationId, taskEventId: parsed.data.taskEventId! },
    { ...options, retry },
  )
}
