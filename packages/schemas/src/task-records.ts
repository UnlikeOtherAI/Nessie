import { z } from 'zod'

import {
  AgentIdSchema,
  OrganizationIdSchema,
  ProjectIdSchema,
  RunIdSchema,
  TaskIdSchema,
  UserIdSchema,
} from './ids.js'
import { TaskExternalLinkRecordSchema } from './board-sources.js'
import { TaskStatusSchema } from './lifecycle.js'
import { TimestampSchema } from './schema-primitives.js'

/**
 * The task record the admin renders directly (board cards, the task detail
 * pane, the tasks list). Lives here — not `api/src/contracts/tasks-board.ts`
 * — because the admin has no import path into `api/src`; the API contract
 * file re-exports this schema so route handlers keep one import surface
 * (docs/architecture.md, "shared runtime schemas").
 */
export const TaskPrioritySchema = z.enum(['low', 'medium', 'high', 'urgent'])
export type TaskPriority = z.infer<typeof TaskPrioritySchema>

export const TaskRecordSchema = z.object({
  id: TaskIdSchema,
  organizationId: OrganizationIdSchema,
  projectId: ProjectIdSchema.nullable(),
  /** The board this task lives on; null ⇒ the project's default board. */
  boardId: z.string().uuid().nullable(),
  iterationId: z.string().uuid().nullable(),
  storyPoints: z.number().int().nullable(),
  fieldValues: z.record(z.string().uuid(), z.unknown()),
  externalLink: TaskExternalLinkRecordSchema.nullable(),
  agentId: AgentIdSchema.nullable(),
  parentTaskId: TaskIdSchema.nullable(),
  runId: RunIdSchema.nullable(),
  status: TaskStatusSchema,
  priority: TaskPrioritySchema,
  dueDate: TimestampSchema.nullable(),
  archivedAt: TimestampSchema.nullable(),
  title: z.string().nullable(),
  purpose: z.string().nullable(),
  detail: z.string().nullable(),
  assigneeUserId: UserIdSchema.nullable(),
  assigneeAgentId: AgentIdSchema.nullable(),
  assigneeName: z.string().nullable(),
  ownerUserId: UserIdSchema.nullable(),
  ownerName: z.string().nullable(),
  createdByUserId: UserIdSchema.nullable(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
})
export type TaskRecord = z.infer<typeof TaskRecordSchema>
