import type { PrismaClient } from '@prisma/client'
import {
  TICKET_WORK_LIVE_STATUSES,
  TicketChangedStoredConfigSchema,
  type TaskEventOrigin,
} from '@nessie/schemas'

import { canMemberEditProjectBoards } from './resource-authority.js'

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
    taskId: string
    boardId: string
    toColumnId: string
    fromColumnId: string | null
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
  const trigger = triggers.find((row) => {
    const config = TicketChangedStoredConfigSchema.safeParse(row.config)
    const pickup = config.success ? config.data.pickup : null
    return row.agentId !== null
      && pickup?.assignOnPickup === true
      && pickup.columnIds.includes(input.toColumnId)
      && !(input.fromColumnId !== null && pickup.columnIds.includes(input.fromColumnId))
  })
  if (!trigger?.agentId) return null
  const live = await prisma.agentTicketWork.count({
    where: { triggerId: trigger.id, taskId: input.taskId, status: { in: [...TICKET_WORK_LIVE_STATUSES] } },
  })
  if (live > 0) return null
  const editor = await canMemberEditProjectBoards(prisma, {
    organizationId: input.organizationId,
    userId: input.actorId,
    projectId: input.projectId,
  })
  return editor ? { agentId: trigger.agentId, triggerId: trigger.id } : null
}
