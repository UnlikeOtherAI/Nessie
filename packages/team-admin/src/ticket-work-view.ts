import type { PrismaClient } from '@prisma/client'
import type { z } from 'zod'
import {
  parseAgentId,
  parseChannelId,
  parseTaskId,
  parseThreadId,
  StandingPolicyBindRefusalReasonSchema,
  TICKET_WORK_ACTIVITY_EVENT_TYPES,
  TICKET_WORK_LIVE_STATUSES,
  TICKET_WORK_NOTICE_SKIP_REASONS,
  TicketChangedStoredConfigSchema,
  TicketTriggerDeliveryPayloadSchema,
  TicketTriggerLimitsSchema,
  TicketWorkActivityPayloadSchema,
  TicketWorkStateReasonSchema,
  TicketWorkStatusSchema,
  TicketWorkWakeReasonSchema,
  ticketWorkThreadMessageOutcome,
  type BoardTicketWorkRecord,
  type TaskTicketWorkRecord,
  type TicketWorkChipRecord,
  type TicketWorkHistoryEntry,
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
 * Why each record's latest wake ran with no machine, when the standing
 * binder refused it: its skipped `binding` delivery, if one is no older
 * than that wake. The sentence never names the machine.
 */
const loadMachineRefusals = async (
  prisma: PrismaClient,
  records: ReadonlyArray<{
    id: string; lastWakeAt: Date | null; startedAt: Date; status: string; triggerId: string | null
  }>,
): Promise<Map<string, NonNullable<TicketWorkChipRecord['machineRefusal']>>> => {
  const refusals = new Map<string, NonNullable<TicketWorkChipRecord['machineRefusal']>>()
  for (const record of records) {
    if (!record.triggerId || !LIVE.has(record.status)) continue
    const delivery = await prisma.agentTriggerDelivery.findFirst({
      where: {
        createdAt: { gte: record.lastWakeAt ?? record.startedAt },
        payload: { path: ['workId'], equals: record.id },
        source: 'binding',
        triggerId: record.triggerId,
      },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true, errorMessage: true, payload: true },
    })
    const reason = StandingPolicyBindRefusalReasonSchema.safeParse(
      (delivery?.payload as { reason?: unknown } | null)?.reason,
    )
    if (delivery?.errorMessage && reason.success) {
      refusals.set(record.id, {
        at: delivery.createdAt.toISOString(), reason: reason.data, sentence: delivery.errorMessage,
      })
    }
  }
  return refusals
}

/**
 * The newest skip the ticket's readers should know about, if nothing newer
 * happened under the same trigger: "moved by an agent, so work did not start"
 * belongs on the ticket that did not start, and "moved back by an agent, so
 * work did not resume" on the ticket whose parked work stayed parked.
 */
const loadLastSkip = async (
  prisma: PrismaClient,
  input: { taskId: string; projectId: string; newestByTrigger: Map<string, Date> },
): Promise<TicketWorkSkipNotice | null> => {
  const deliveries = await prisma.agentTriggerDelivery.findMany({
    where: {
      status: { in: ['skipped', 'failed'] },
      source: { in: ['pickup', 'follow'] },
      trigger: { type: 'ticket_changed', scopeProjectId: input.projectId },
      payload: { path: ['taskId'], equals: input.taskId },
    },
    orderBy: { createdAt: 'desc' },
    take: 10,
    select: {
      createdAt: true,
      payload: true,
      source: true,
      status: true,
      triggerId: true,
      trigger: { select: { agent: { select: { name: true } }, status: true } },
    },
  })
  const notice = new Set<string>(TICKET_WORK_NOTICE_SKIP_REASONS)
  for (const delivery of deliveries) {
    const payload = TicketTriggerDeliveryPayloadSchema.safeParse(delivery.payload)
    if (!payload.success) continue
    // A pickup that failed and switched its trigger off (its health) is said
    // too: the move may already have assigned the agent, and started nothing.
    if (delivery.status === 'failed') {
      const unhealthy = delivery.trigger.status === 'error' || delivery.trigger.status === 'needs_reauthorization'
      if (delivery.source !== 'pickup' || !unhealthy) continue
      const newer = input.newestByTrigger.get(delivery.triggerId)
      if (newer && newer >= delivery.createdAt) return null
      return {
        triggerId: delivery.triggerId,
        agentName: delivery.trigger.agent?.name ?? 'The agent',
        reason: 'trigger_failed',
        reentry: false,
        at: delivery.createdAt.toISOString(),
      }
    }
    if (!payload.data.skipReason || !notice.has(payload.data.skipReason)) continue
    // A follow skip is a notice only when it refused a re-entry; any other is
    // bookkeeping the Triggers page shows its owner.
    const reentry = payload.data.reentry === true
    if (delivery.source === 'follow' && !reentry) continue
    const newer = input.newestByTrigger.get(delivery.triggerId)
    if (newer && newer >= delivery.createdAt) return null
    return {
      triggerId: delivery.triggerId,
      agentName: delivery.trigger.agent?.name ?? 'The agent',
      reason: payload.data.skipReason,
      reentry,
      at: delivery.createdAt.toISOString(),
    }
  }
  return null
}

/** How many `work_*` rows the chip's history lists. */
const HISTORY_LIMIT = 12

/**
 * The ticket's `work_*` activity, newest first: each start, park, resume and
 * end, with its reason and who caused it — a person by name, an agent by its
 * name, or nobody when the platform acted on its own.
 */
const loadWorkHistory = async (prisma: PrismaClient, taskId: string): Promise<TicketWorkHistoryEntry[]> => {
  const rows = await prisma.taskEvent.findMany({
    where: { taskId, eventType: { in: [...TICKET_WORK_ACTIVITY_EVENT_TYPES] } },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: HISTORY_LIMIT,
    select: { id: true, eventType: true, payload: true, createdAt: true },
  })
  const parsed = rows.flatMap((row) => {
    const payload = TicketWorkActivityPayloadSchema.safeParse(row.payload)
    const eventType = TICKET_WORK_ACTIVITY_EVENT_TYPES.find((type) => type === row.eventType)
    return payload.success && eventType ? [{ row, eventType, payload: payload.data }] : []
  })
  const agentIds = new Set(parsed.map(({ payload }) => payload.agentId))
  const userIds = new Set<string>()
  for (const { payload } of parsed) {
    if (payload.by?.startsWith('agent:')) agentIds.add(payload.by.slice('agent:'.length))
    else if (payload.by && !payload.by.includes(':')) userIds.add(payload.by)
  }
  const [agents, users] = await Promise.all([
    prisma.agent.findMany({ where: { id: { in: [...agentIds] } }, select: { id: true, name: true } }),
    prisma.user.findMany({ where: { id: { in: [...userIds] } }, select: { id: true, displayName: true } }),
  ])
  const agentName = new Map(agents.map((agent) => [agent.id, agent.name]))
  const userName = new Map(users.map((user) => [user.id, user.displayName]))
  const nameOf = (by: string | undefined): string | null => {
    if (!by) return null
    if (by.startsWith('agent:')) return agentName.get(by.slice('agent:'.length)) ?? 'An agent'
    if (by.startsWith('source:')) return 'The connected board'
    return userName.get(by) ?? 'A former member'
  }
  return parsed.map(({ row, eventType, payload }) => ({
    id: row.id,
    eventType,
    agentName: agentName.get(payload.agentId) ?? 'The agent',
    status: payload.status,
    reason: payload.reason,
    byName: nameOf(payload.by),
    at: row.createdAt.toISOString(),
  }))
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
  if (!task) return { records: [], lastSkip: null, history: [] }
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
      queuePosition: true,
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

  const refusals = await loadMachineRefusals(prisma, picked)
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
    queuePosition: row.status === 'queued' ? row.queuePosition : null,
    machineRefusal: refusals.get(row.id) ?? null,
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
  return { records, lastSkip, history: await loadWorkHistory(prisma, input.taskId) }
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
  input: { threadId: string; organizationId: string; userId: string; isOrganizationAdmin?: boolean },
): Promise<TicketWorkThreadGate | null | undefined> => {
  const visible = await prisma.thread.findFirst({
    where: { id: input.threadId, ...buildViewerThreadWhere(input.userId, input.organizationId) },
    select: { id: true },
  })
  if (!visible) return undefined
  const work = await findTicketWorkThread(prisma, input.threadId)
  if (!work || work.organizationId !== input.organizationId) return null
  // The record a message would wake — the live one, else the newest — as the
  // dispatcher picks it (`ticketWorkThreadMessageOutcome`).
  const trigger = { select: { config: true, enabled: true, status: true } } as const
  const record = await prisma.agentTicketWork.findFirst({
    where: { threadId: input.threadId, status: { in: [...TICKET_WORK_LIVE_STATUSES] } },
    select: { status: true, trigger },
  }) ?? await prisma.agentTicketWork.findFirst({
    where: { threadId: input.threadId },
    orderBy: { startedAt: 'desc' },
    select: { status: true, trigger },
  })
  const config = TicketChangedStoredConfigSchema.safeParse(record?.trigger?.config)
  const task = await prisma.task.findUnique({
    where: { id: work.taskId },
    select: { externalLink: { select: { externalKey: true } }, title: true },
  })
  return {
    taskId: parseTaskId(work.taskId),
    projectId: work.projectId,
    taskTitle: ticketWorkThreadTitle({ externalLink: task?.externalLink ?? null, title: task?.title ?? null }),
    viewerCanPost: await canPostInTicketWorkThread(prisma, {
      thread: work,
      userId: input.userId,
      ...(input.isOrganizationAdmin === undefined ? {} : { isOrganizationAdmin: input.isOrganizationAdmin }),
    }),
    // A deleted trigger wakes nobody, the way a disabled one does not.
    messageOutcome: record?.trigger
      ? ticketWorkThreadMessageOutcome({
          workStatus: record.status,
          trigger: record.trigger,
          followKinds: config.success ? config.data.follow.kinds : null,
        })
      : record && LIVE.has(record.status) ? 'trigger_disabled' : 'work_ended',
  }
}
