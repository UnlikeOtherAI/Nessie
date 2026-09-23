import type { PrismaClient } from '@prisma/client'
import type { z } from 'zod'
import {
  parseAgentId,
  parseChannelId,
  parseTaskId,
  parseThreadId,
  TICKET_WORK_LIVE_STATUSES,
  TICKET_WORK_NOTICE_SKIP_REASONS,
  TicketChangedStoredConfigSchema,
  TicketTriggerDeliveryPayloadSchema,
  TicketTriggerLimitsSchema,
  TicketWorkStateReasonSchema,
  TicketWorkStatusSchema,
  TicketWorkWakeReasonSchema,
  type BoardTicketWorkRecord,
  type TaskTicketWorkRecord,
  type TicketWorkChipRecord,
  type TicketWorkSkipNotice,
  type TicketWorkStatus,
  type TicketWorkThreadGate,
} from '@nessie/schemas'

import { buildViewerThreadWhere } from './agent-conversations.js'
import { canPostInTicketWorkThread, findTicketWorkThread, ticketWorkThreadTitle } from './ticket-work-thread.js'

/**
 * The reads behind what the project sees of a ticket's work
 * (docs/standards/ticket-work.md → "What the project sees"): the ticket
 * dialog's chip, the board's column badges and card dots, and whether a work
 * thread's reader may write in it.
 *
 * The callers gate on the ticket's or the board's own read rule first; these
 * never widen it. None of them names a machine, and a work thread is linked
 * only for a viewer who may open it.
 */

const LIVE = new Set<string>(TICKET_WORK_LIVE_STATUSES)

/** How many of a ticket's triggers the chip names at once. */
const CHIP_RECORD_LIMIT = 3

/** A stored vocabulary value, or null: a CHECK holds the column, so null means unset. */
const nullableReason = <T extends z.ZodTypeAny>(schema: T, value: unknown): z.infer<T> | null => {
  if (value === null || value === undefined) return null
  const parsed = schema.safeParse(value)
  return parsed.success ? parsed.data : null
}

/** The trigger's `limits.wakesPerTicket`, as the platform enforces it. */
const wakeLimitOf = (config: unknown): number | null => {
  const limits = config && typeof config === 'object' && !Array.isArray(config)
    ? (config as Record<string, unknown>).limits
    : undefined
  const parsed = TicketTriggerLimitsSchema.safeParse(limits ?? {})
  return parsed.success ? parsed.data.wakesPerTicket : null
}

const byLiveThenNewest = (
  left: { status: string; startedAt: Date },
  right: { status: string; startedAt: Date },
): number => {
  const live = Number(LIVE.has(right.status)) - Number(LIVE.has(left.status))
  return live !== 0 ? live : right.startedAt.getTime() - left.startedAt.getTime()
}

/**
 * The newest pickup skip the ticket's readers should know about, if nothing
 * newer happened under the same trigger: "moved by an agent, so work did not
 * start" belongs on the ticket that did not start.
 */
const loadLastSkip = async (
  prisma: PrismaClient,
  input: { taskId: string; projectId: string; newestByTrigger: Map<string, Date> },
): Promise<TicketWorkSkipNotice | null> => {
  const deliveries = await prisma.agentTriggerDelivery.findMany({
    where: {
      status: 'skipped',
      source: 'pickup',
      trigger: { type: 'ticket_changed', scopeProjectId: input.projectId },
      payload: { path: ['taskId'], equals: input.taskId },
    },
    orderBy: { createdAt: 'desc' },
    take: 5,
    select: {
      createdAt: true,
      payload: true,
      triggerId: true,
      trigger: { select: { agent: { select: { name: true } } } },
    },
  })
  const notice = new Set<string>(TICKET_WORK_NOTICE_SKIP_REASONS)
  for (const delivery of deliveries) {
    const payload = TicketTriggerDeliveryPayloadSchema.safeParse(delivery.payload)
    if (!payload.success || !payload.data.skipReason || !notice.has(payload.data.skipReason)) continue
    const newer = input.newestByTrigger.get(delivery.triggerId)
    if (newer && newer >= delivery.createdAt) return null
    return {
      triggerId: delivery.triggerId,
      agentName: delivery.trigger.agent?.name ?? 'The agent',
      reason: payload.data.skipReason,
      at: delivery.createdAt.toISOString(),
    }
  }
  return null
}

/** `GET /api/tasks/:taskId/work`, for a viewer the caller already let read the ticket. */
export const loadTaskTicketWork = async (
  prisma: PrismaClient,
  input: { taskId: string; organizationId: string; viewerUserId: string },
): Promise<TaskTicketWorkRecord> => {
  const task = await prisma.task.findFirst({
    where: { id: input.taskId, organizationId: input.organizationId },
    select: { projectId: true },
  })
  if (!task) return { records: [], lastSkip: null }
  const rows = await prisma.agentTicketWork.findMany({
    where: { taskId: input.taskId, organizationId: input.organizationId },
    orderBy: { startedAt: 'desc' },
    take: 20,
    select: {
      agent: { select: { id: true, name: true } },
      endedAt: true,
      id: true,
      lastWakeAt: true,
      lastWakeReason: true,
      startedAt: true,
      startedBy: { select: { displayName: true } },
      stateReason: true,
      status: true,
      thread: { select: { channelId: true, id: true } },
      trigger: { select: { config: true } },
      triggerId: true,
      wakeCount: true,
    },
  })
  // The newest record of each trigger: a ticket worked twice is one chip.
  const newest = new Map<string, (typeof rows)[number]>()
  for (const row of rows) {
    const key = row.triggerId ?? row.id
    if (!newest.has(key)) newest.set(key, row)
  }
  const picked = [...newest.values()].sort(byLiveThenNewest).slice(0, CHIP_RECORD_LIMIT)
  const openable = new Set((await prisma.thread.findMany({
    where: {
      id: { in: picked.map((row) => row.thread.id) },
      ...buildViewerThreadWhere(input.viewerUserId, input.organizationId),
    },
    select: { id: true },
  })).map((thread) => thread.id))

  const records: TicketWorkChipRecord[] = picked.map((row) => ({
    id: row.id,
    triggerId: row.triggerId,
    agent: { id: parseAgentId(row.agent.id), name: row.agent.name },
    status: TicketWorkStatusSchema.parse(row.status),
    stateReason: nullableReason(TicketWorkStateReasonSchema, row.stateReason),
    startedAt: row.startedAt.toISOString(),
    startedByName: row.startedBy?.displayName ?? null,
    endedAt: row.endedAt?.toISOString() ?? null,
    lastWakeAt: row.lastWakeAt?.toISOString() ?? null,
    lastWakeReason: nullableReason(TicketWorkWakeReasonSchema, row.lastWakeReason),
    wakeCount: row.wakeCount,
    wakeLimit: row.trigger ? wakeLimitOf(row.trigger.config) : null,
    thread: openable.has(row.thread.id)
      ? { id: parseThreadId(row.thread.id), channelId: parseChannelId(row.thread.channelId) }
      : null,
  }))

  const newestByTrigger = new Map<string, Date>()
  for (const row of rows) {
    if (!row.triggerId) continue
    const at = row.lastWakeAt && row.lastWakeAt > row.startedAt ? row.lastWakeAt : row.startedAt
    const known = newestByTrigger.get(row.triggerId)
    if (!known || at > known) newestByTrigger.set(row.triggerId, at)
  }
  const lastSkip = task.projectId
    ? await loadLastSkip(prisma, { taskId: input.taskId, projectId: task.projectId, newestByTrigger })
    : null
  return { records, lastSkip }
}

/** The statuses a board card shows a dot for: live work, and work a limit stopped. */
const CARD_STATUSES = new Set<TicketWorkStatus>([...TICKET_WORK_LIVE_STATUSES, 'failed'])

/**
 * `GET /api/projects/:projectId/boards/:boardId/ticket-work`: the columns that
 * start work, as the dispatcher finds them (enabled, active, scoped to this
 * board), and the project's cards whose newest work is live or stopped.
 */
export const loadBoardTicketWork = async (
  prisma: PrismaClient,
  input: { board: { id: string; projectId: string }; organizationId: string; viewerCanCreateTriggers: boolean },
): Promise<BoardTicketWorkRecord> => {
  const [triggers, columns, newest] = await Promise.all([
    prisma.agentTrigger.findMany({
      where: {
        type: 'ticket_changed',
        enabled: true,
        status: 'active',
        scopeBoardId: input.board.id,
        agent: { organizationId: input.organizationId },
      },
      orderBy: { createdAt: 'asc' },
      select: { agent: { select: { id: true, name: true } }, config: true, id: true },
    }),
    prisma.boardColumn.findMany({ where: { boardId: input.board.id }, select: { id: true } }),
    // One row per ticket: its newest record, whatever its status.
    prisma.agentTicketWork.findMany({
      where: { projectId: input.board.projectId, organizationId: input.organizationId },
      distinct: ['taskId'],
      orderBy: [{ taskId: 'asc' }, { startedAt: 'desc' }],
      select: {
        agent: { select: { id: true, name: true } },
        stateReason: true,
        status: true,
        taskId: true,
      },
    }),
  ])
  const columnIds = new Set(columns.map((column) => column.id))
  const pickups = triggers.flatMap((trigger) => {
    const parsed = TicketChangedStoredConfigSchema.safeParse(trigger.config)
    if (!trigger.agent || !parsed.success || !parsed.data.pickup) return []
    const agent = trigger.agent
    return parsed.data.pickup.columnIds
      .filter((columnId) => columnIds.has(columnId))
      .map((columnId) => ({
        columnId,
        triggerId: trigger.id,
        agentId: parseAgentId(agent.id),
        agentName: agent.name,
      }))
  })
  const cards = newest.flatMap((row) => {
    const status = TicketWorkStatusSchema.parse(row.status)
    if (!CARD_STATUSES.has(status)) return []
    return [{
      taskId: parseTaskId(row.taskId),
      agentId: parseAgentId(row.agent.id),
      agentName: row.agent.name,
      status,
      stateReason: nullableReason(TicketWorkStateReasonSchema, row.stateReason),
    }]
  })
  return { pickups, cards, viewerCanCreateTriggers: input.viewerCanCreateTriggers }
}

/**
 * `GET /api/threads/:threadId/ticket-work`. `undefined` when the viewer may
 * not open the thread at all (the route answers as for any unknown thread);
 * null for a thread that is not a work thread.
 */
export const loadTicketWorkThreadGate = async (
  prisma: PrismaClient,
  input: { threadId: string; organizationId: string; userId: string },
): Promise<TicketWorkThreadGate | null | undefined> => {
  const visible = await prisma.thread.findFirst({
    where: { id: input.threadId, ...buildViewerThreadWhere(input.userId, input.organizationId) },
    select: { id: true },
  })
  if (!visible) return undefined
  const work = await findTicketWorkThread(prisma, input.threadId)
  if (!work || work.organizationId !== input.organizationId) return null
  const task = await prisma.task.findUnique({
    where: { id: work.taskId },
    select: { externalLink: { select: { externalKey: true } }, title: true },
  })
  return {
    taskId: parseTaskId(work.taskId),
    projectId: work.projectId,
    taskTitle: ticketWorkThreadTitle({ externalLink: task?.externalLink ?? null, title: task?.title ?? null }),
    viewerCanPost: await canPostInTicketWorkThread(prisma, { thread: work, userId: input.userId }),
  }
}
