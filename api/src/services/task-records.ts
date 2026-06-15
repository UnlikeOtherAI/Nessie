import type { Prisma } from '@prisma/client'
import {
  parseAgentId,
  parseOrganizationId,
  parseProjectId,
  parseTaskId,
  parseUserId,
} from '@nessie/schemas'
import type { TaskRecord } from '../contracts.js'

export const taskInclude = {
  assignee: { select: { displayName: true } },
  assigneeAgent: { select: { name: true } },
  owner: { select: { displayName: true } },
} satisfies Prisma.TaskInclude

type TaskWithUsers = Prisma.TaskGetPayload<{ include: typeof taskInclude }>

export const mapTask = (task: TaskWithUsers): TaskRecord => ({
  id: parseTaskId(task.id),
  organizationId: parseOrganizationId(task.organizationId),
  projectId: task.projectId ? parseProjectId(task.projectId) : null,
  columnId: task.columnId ?? null,
  position: task.position,
  iterationId: task.iterationId ?? null,
  storyPoints: task.storyPoints ?? null,
  agentId: task.agentId ? parseAgentId(task.agentId) : null,
  parentTaskId: task.parentTaskId ? parseTaskId(task.parentTaskId) : null,
  runId: task.runId ? (task.runId as TaskRecord['runId']) : null,
  status: task.status,
  priority: task.priority,
  dueDate: task.dueDate ? task.dueDate.toISOString() : null,
  archivedAt: task.archivedAt ? task.archivedAt.toISOString() : null,
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
