import type { PrismaClient } from '@prisma/client'
import {
  TICKET_WORK_LIVE_STATUSES,
  TicketChangedStoredConfigSchema,
  type TaskEventOrigin,
} from '@nessie/schemas'

import { resolveBoardPlacement } from './board-placement.js'
import { canMemberEditProjectBoards } from './resource-authority.js'
import { recordTaskEvent, type TaskEventScope, type TaskEventWriter } from './task-event-dispatch.js'

/**
 * `assignOnPickup` (docs/plans/2026-09-23-ticket-driven-agents/triggers.md →
 * "Configuration"), decided for a move before its transaction opens so the
 * move itself can write it.
 *
 * When an unassigned ticket enters a start-work column of an enabled ticket
 * trigger that assigns on pickup, **and the move itself qualifies as a
 * pickup** — a person's own session, someone who can edit the board right now,
 * from outside the start-work set, with no live work of that trigger on the
 * ticket — the trigger's agent is assigned instead of the mover. That replaces
 * the assign-the-mover rule for that move only. Any other move keeps today's
 * behaviour: an agent's, a token's or a source's move never assigns the agent,
 * and a ticket that already has an assignee, a person or an agent, is never
 * reassigned (the caller asks only for an unassigned ticket).
 *
 * Every door that can start work applies it: a drag or `ticket_move`
 * (`moveProjectTaskToColumn`), a status transition and a create straight into
 * a start-work column (`resolvePickupAssignmentForStatus`).
 *
 * The dispatcher asks the same questions again when it decides the pickup, a
 * moment later; the two can only disagree when the mover lost the right to
 * edit the board in between, and then the agent is assigned and starts nothing.
 */
export type PickupAssignment = { agentId: string; triggerId: string }

export const resolvePickupAssignment = async (
  prisma: PrismaClient,
  input: {
    organizationId: string
    projectId: string
    /** Null for a ticket being created, which can have no work yet. */
    taskId: string | null
    boardId: string
    toColumnId: string
    /** Where the ticket renders before the move; read only when a trigger could pick it up. */
    fromColumnId: () => Promise<string | null>
    actorId: string | null
    origin?: TaskEventOrigin
  },
): Promise<PickupAssignment | null> => {
  if (input.origin?.kind !== 'session' || !input.actorId) return null
  const triggers = await prisma.agentTrigger.findMany({
    where: { type: 'ticket_changed', enabled: true, status: 'active', scopeBoardId: input.boardId },
    select: { id: true, agentId: true, config: true },
    orderBy: { createdAt: 'asc' },
  })
  const trigger = triggers.flatMap((row) => {
    const config = TicketChangedStoredConfigSchema.safeParse(row.config)
    const pickup = config.success ? config.data.pickup : null
    return row.agentId && pickup?.assignOnPickup === true && pickup.columnIds.includes(input.toColumnId)
      ? [{ id: row.id, agentId: row.agentId, columnIds: pickup.columnIds }]
      : []
  })[0]
  if (!trigger) return null
  // Only entering the start-work set is a pickup, never a move between two of its columns.
  const fromColumnId = await input.fromColumnId()
  if (fromColumnId !== null && trigger.columnIds.includes(fromColumnId)) return null
  const live = input.taskId
    ? await prisma.agentTicketWork.count({
        where: { triggerId: trigger.id, taskId: input.taskId, status: { in: [...TICKET_WORK_LIVE_STATUSES] } },
      })
    : 0
  if (live > 0) return null
  const editor = await canMemberEditProjectBoards(prisma, {
    organizationId: input.organizationId,
    userId: input.actorId,
    projectId: input.projectId,
  })
  return editor ? { agentId: trigger.agentId, triggerId: trigger.id } : null
}

/**
 * The `assigned` row an `assignOnPickup` writes, in the transaction that
 * assigns: the platform assigned the agent, not the mover, so its origin is
 * `system` and it wakes nothing.
 */
export const recordPickupAssignment = (
  tx: TaskEventWriter,
  input: { taskId: string; scope: TaskEventScope; pickup: PickupAssignment },
): Promise<{ id: string }> => recordTaskEvent(tx, {
  taskId: input.taskId,
  eventType: 'assigned',
  payload: {
    origin: { kind: 'system' },
    assigneeUserId: null,
    assigneeAgentId: input.pickup.agentId,
    reason: 'assign_on_pickup',
    triggerId: input.pickup.triggerId,
  },
  scope: input.scope,
})

/**
 * The same rule for a door that places a ticket by its status rather than by
 * naming a column — a status transition, or a create — so the column is the
 * one that status puts it in on its home board. Null when the ticket would
 * land in no column, or no trigger could pick it up there.
 */
export const resolvePickupAssignmentForStatus = async (
  prisma: PrismaClient,
  input: {
    organizationId: string
    task: { id: string | null; projectId: string; boardId: string | null; status: string }
    fromColumnId: () => Promise<string | null>
    actorId: string | null
    origin?: TaskEventOrigin
  },
): Promise<PickupAssignment | null> => {
  if (input.origin?.kind !== 'session' || !input.actorId) return null
  const board = await prisma.board.findFirst({
    where: {
      projectId: input.task.projectId,
      ...(input.task.boardId ? { id: input.task.boardId } : { isDefault: true }),
    },
    select: { id: true, columns: { select: { id: true, category: true, position: true } } },
  })
  if (!board) return null
  const pin = input.task.id
    ? await prisma.taskBoardPlacement.findUnique({
        where: { taskId_boardId: { taskId: input.task.id, boardId: board.id } },
        select: { columnId: true, position: true },
      })
    : null
  const placement = resolveBoardPlacement(
    { status: input.task.status, archivedAt: null },
    board.columns,
    pin ?? undefined,
  )
  const toColumnId = placement?.columnId
  if (!toColumnId) return null
  return resolvePickupAssignment(prisma, {
    organizationId: input.organizationId,
    projectId: input.task.projectId,
    taskId: input.task.id,
    boardId: board.id,
    toColumnId,
    fromColumnId: input.fromColumnId,
    actorId: input.actorId,
    ...(input.origin ? { origin: input.origin } : {}),
  })
}
