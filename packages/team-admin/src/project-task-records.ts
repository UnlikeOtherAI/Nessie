import type { Prisma, PrismaClient } from '@prisma/client'
import {
  parseAgentId,
  parseOrganizationId,
  parseProjectId,
  parseTaskId,
  parseUserId,
} from '@nessie/schemas'

export type ProjectTaskRecord = {
  id: string
  organizationId: string
  projectId: string | null
  /** The board this task lives on; null ⇒ the project's default board. */
  boardId: string | null
  iterationId: string | null
  fieldValues: Record<string, unknown>
  /** Present only on a task mirrored from an external source. */
  externalLink: {
    sourceId: string
    provider: 'jira' | 'linear' | 'trello' | 'github'
    externalKey: string
    externalUrl: string
    remoteStateName: string | null
    /** The provider's own id for an assignee no identity link resolves. */
    remoteAssigneeExternalId: string | null
    remoteAssigneeDisplay: string | null
    lastInboundAt: string | null
    writeMode: 'read_only' | 'read_write'
  } | null
  storyPoints: number | null
  agentId: string | null
  parentTaskId: string | null
  runId: string | null
  status: 'inbox' | 'assigned' | 'in_progress' | 'review' | 'done' | 'failed' | 'cancelled' | 'awaiting_approval'
  priority: 'low' | 'medium' | 'high' | 'urgent'
  dueDate: string | null
  archivedAt: string | null
  title: string | null
  purpose: string | null
  detail: string | null
  assigneeUserId: string | null
  assigneeAgentId: string | null
  assigneeName: string | null
  ownerUserId: string | null
  ownerName: string | null
  createdByUserId: string | null
  /** The ticket's labels, in name order. */
  labels: { id: string; name: string; color: string; external: boolean }[]
  /** Comments not deleted. */
  commentCount: number
  /** Files linked to the ticket (`Attachment.taskId`), comment files included. */
  attachmentCount: number
  /** Whether the viewer this record was mapped for may change the ticket. */
  viewerCanEdit: boolean
  createdAt: string
  updatedAt: string
}

export const projectTaskInclude = {
  assignee: { select: { displayName: true } },
  assigneeAgent: { select: { name: true } },
  owner: { select: { displayName: true } },
  // One row, so this costs a join rather than a second read — and every
  // surface that renders a task can say where it came from.
  externalLink: {
    select: {
      sourceId: true,
      externalKey: true,
      externalUrl: true,
      remoteStateName: true,
      remoteAssigneeExternalId: true,
      remoteAssigneeDisplay: true,
      lastInboundAt: true,
      source: { select: { provider: true, writeMode: true } },
    },
  },
  labels: {
    select: { label: { select: { id: true, name: true, color: true, sourceId: true } } },
    orderBy: { label: { name: 'asc' } },
  },
  _count: { select: { comments: { where: { deletedAt: null } } } },
} satisfies Prisma.TaskInclude

type TaskWithPeople = Prisma.TaskGetPayload<{ include: typeof projectTaskInclude }>

/**
 * What the mapper needs beyond the row. `Attachment.taskId` is an app-enforced
 * pointer with no relation (the `messageId` precedent), so its count cannot
 * ride the include; callers that render the count pass it, and it is 0
 * otherwise.
 */
export type ProjectTaskMapContext = {
  attachmentCount?: number
  /**
   * Defaults to `true`, and that default is the rule, not a guess: every door
   * that returns a task today — the task list and detail, the board read, the
   * search, the PA's ticket tools — gates on the same visibility the task
   * mutation routes (`requireTaskAccess`) gate on, so a viewer holding a
   * record may change it. A read door that ever shows a task to somebody who
   * may not change it (an organisation member reading a public project they
   * are not in) must pass `false`.
   */
  viewerCanEdit?: boolean
}

/** Count the live (not removed) files linked to each task, for `ProjectTaskMapContext.attachmentCount`. */
export const countTaskAttachments = async (
  prisma: { attachment: { groupBy: PrismaClient['attachment']['groupBy'] } },
  taskIds: readonly string[],
): Promise<Map<string, number>> => {
  if (taskIds.length === 0) return new Map()
  const rows = await prisma.attachment.groupBy({
    by: ['taskId'],
    // The card's paperclip counts live files only; a removed file stays on the
    // ticket's list, marked, but not here.
    where: { taskId: { in: [...taskIds] }, removedAt: null },
    _count: { _all: true },
  })
  return new Map(rows.flatMap((row) => (row.taskId ? [[row.taskId, row._count._all] as const] : [])))
}

/**
 * Map one row with no extra context (`attachmentCount` 0, `viewerCanEdit`
 * true). Single-argument so it stays safe to pass straight to `Array#map`.
 */
export const mapProjectTask = (task: TaskWithPeople): ProjectTaskRecord =>
  mapProjectTaskWithContext(task, {})

export const mapProjectTaskWithContext = (
  task: TaskWithPeople,
  context: ProjectTaskMapContext,
): ProjectTaskRecord => ({
  id: parseTaskId(task.id),
  organizationId: parseOrganizationId(task.organizationId),
  projectId: task.projectId ? parseProjectId(task.projectId) : null,
  boardId: task.boardId ?? null,
  fieldValues:
    task.fieldValues && typeof task.fieldValues === 'object' && !Array.isArray(task.fieldValues)
      ? (task.fieldValues as Record<string, unknown>)
      : {},
  externalLink: task.externalLink
    ? {
        sourceId: task.externalLink.sourceId,
        provider: task.externalLink.source.provider,
        externalKey: task.externalLink.externalKey,
        externalUrl: task.externalLink.externalUrl,
        remoteStateName: task.externalLink.remoteStateName,
        remoteAssigneeExternalId: task.externalLink.remoteAssigneeExternalId,
        remoteAssigneeDisplay: task.externalLink.remoteAssigneeDisplay,
        lastInboundAt: task.externalLink.lastInboundAt?.toISOString() ?? null,
        writeMode: task.externalLink.source.writeMode,
      }
    : null,
  iterationId: task.iterationId ?? null,
  storyPoints: task.storyPoints ?? null,
  agentId: task.agentId ? parseAgentId(task.agentId) : null,
  parentTaskId: task.parentTaskId ? parseTaskId(task.parentTaskId) : null,
  runId: task.runId ?? null,
  status: task.status,
  priority: task.priority,
  dueDate: task.dueDate?.toISOString() ?? null,
  archivedAt: task.archivedAt?.toISOString() ?? null,
  title: task.title,
  purpose: task.purpose,
  detail: task.detail,
  assigneeUserId: task.assigneeUserId ? parseUserId(task.assigneeUserId) : null,
  assigneeAgentId: task.assigneeAgentId ? parseAgentId(task.assigneeAgentId) : null,
  assigneeName: task.assignee?.displayName ?? task.assigneeAgent?.name ?? null,
  ownerUserId: task.ownerUserId ? parseUserId(task.ownerUserId) : null,
  ownerName: task.owner?.displayName ?? null,
  createdByUserId: task.createdByUserId ? parseUserId(task.createdByUserId) : null,
  labels: task.labels.map(({ label }) => ({
    id: label.id,
    name: label.name,
    color: label.color,
    external: label.sourceId !== null,
  })),
  commentCount: task._count.comments,
  attachmentCount: context.attachmentCount ?? 0,
  viewerCanEdit: context.viewerCanEdit ?? true,
  createdAt: task.createdAt.toISOString(),
  updatedAt: task.updatedAt.toISOString(),
})
