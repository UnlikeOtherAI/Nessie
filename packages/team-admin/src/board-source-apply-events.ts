import type { Prisma, TaskStatus } from '@prisma/client'
import type { TaskEventOrigin } from '@nessie/schemas'

import { resolveProjectTaskDetailPlacement } from './board-placement.js'
import { recordColumnEntered } from './task-column-events.js'
import { recordTaskEvent, taskDetailSha256 } from './task-event-dispatch.js'

/**
 * The history an inbound board-source change writes. Every row names the
 * source as its author (`source:<id>`) and carries the `source` origin, so a
 * ticket trigger can tell a provider's change from a person's: a source event
 * never starts or resumes work, and wakes live work only when the trigger
 * opts in with `follow.includeSourceEvents` (docs/standards/ticket-work.md).
 */
export const sourceEventAuthorship = (
  sourceId: string,
): { by: string; origin: TaskEventOrigin } => ({
  by: `source:${sourceId}`,
  origin: { kind: 'source', boardSourceId: sourceId },
})

/** The fields of a mirrored ticket its history compares before and after. */
export type InboundTaskState = {
  status: TaskStatus
  archivedAt: Date | null
  assigneeUserId: string | null
  assigneeAgentId: string | null
  detail: string | null
}

type EventTransaction = Parameters<typeof recordColumnEntered>[0]
  & Pick<Prisma.TransactionClient, 'board' | 'taskBoardPlacement'>

export const recordInboundItemEvents = async (
  tx: EventTransaction,
  input: {
    source: { id: string; organizationId: string; projectId: string }
    taskId: string
    boardId: string | null
    /** Null when the sync just created the ticket. */
    previous: InboundTaskState | null
    next: InboundTaskState
    remoteStateId: string
  },
): Promise<void> => {
  const authorship = sourceEventAuthorship(input.source.id)
  const scope = { organizationId: input.source.organizationId, projectId: input.source.projectId }
  const placementOf = (state: InboundTaskState) =>
    resolveProjectTaskDetailPlacement(tx, {
      id: input.taskId,
      projectId: input.source.projectId,
      boardId: input.boardId,
      status: state.status,
      archivedAt: state.archivedAt,
    })
  const record = (eventType: string, payload: Prisma.InputJsonObject) =>
    recordTaskEvent(tx, { taskId: input.taskId, eventType, payload: { ...authorship, ...payload }, scope })

  const { previous, next } = input
  if (!previous) {
    // A ticket the sync creates straight into a start-work column is still a
    // provider's change: it is recorded where it landed, and starts nothing.
    const placement = await placementOf(next)
    await record('created', {
      assigneeUserId: next.assigneeUserId,
      boardId: placement?.boardId ?? null,
      columnId: placement?.columnId ?? null,
    })
    return
  }
  if (previous.status !== next.status) {
    // The vendor is the authority for its own item, so this bypasses
    // `VALID_TRANSITIONS` — but it still records who moved it and from what.
    await record('status_changed', {
      bySourceId: input.source.id,
      from: previous.status,
      to: next.status,
      remoteStateId: input.remoteStateId,
    })
  }
  await recordColumnEntered(tx, {
    taskId: input.taskId,
    scope,
    fromColumnId: (await placementOf(previous))?.columnId ?? null,
    toColumnId: (await placementOf(next))?.columnId ?? null,
    authorship,
  })
  if (
    previous.assigneeUserId !== next.assigneeUserId
    || previous.assigneeAgentId !== next.assigneeAgentId
  ) {
    const assigned = Boolean(next.assigneeUserId || next.assigneeAgentId)
    await record(assigned ? 'assigned' : 'unassigned', {
      assigneeUserId: next.assigneeUserId,
      assigneeAgentId: next.assigneeAgentId,
    })
  }
  if ((previous.detail ?? null) !== (next.detail ?? null)) {
    await record('detail_edited', {
      detailSha256: taskDetailSha256(next.detail ?? null),
      previousDetailSha256: taskDetailSha256(previous.detail ?? null),
    })
  }
}
