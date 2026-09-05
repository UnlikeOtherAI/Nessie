import type { Prisma } from '@prisma/client'
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
      remoteAssigneeDisplay: true,
      lastInboundAt: true,
      source: { select: { provider: true, writeMode: true } },
    },
  },
} satisfies Prisma.TaskInclude

type TaskWithPeople = Prisma.TaskGetPayload<{ include: typeof projectTaskInclude }>

export const mapProjectTask = (task: TaskWithPeople): ProjectTaskRecord => ({
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
  createdAt: task.createdAt.toISOString(),
  updatedAt: task.updatedAt.toISOString(),
})
