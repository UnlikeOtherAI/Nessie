import {
  AgentIdSchema,
  OrganizationIdSchema,
  ProjectIdSchema,
  RunIdSchema,
  TaskIdSchema,
  TaskStatusSchema,
  UserIdSchema,
} from '@nessie/schemas'
import { z } from 'zod'

import { NonEmptyStringSchema, TimestampSchema } from './shared.js'

// ─── Tasks (human work distribution) ──────────────────────────────────────

export const TaskPrioritySchema = z.enum(['low', 'medium', 'high', 'urgent'])
export type TaskPriority = z.infer<typeof TaskPrioritySchema>

export const TaskRecordSchema = z.object({
  id: TaskIdSchema,
  organizationId: OrganizationIdSchema,
  projectId: ProjectIdSchema.nullable(),
  columnId: z.string().uuid().nullable(),
  iterationId: z.string().uuid().nullable(),
  storyPoints: z.number().int().nullable(),
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

export const CreateTaskBodySchema = z.object({
  title: NonEmptyStringSchema,
  purpose: z.string().optional(),
  detail: z.string().optional(),
  projectId: ProjectIdSchema.optional(),
  iterationId: z.string().uuid().optional(),
  storyPoints: z.number().int().min(0).optional(),
  priority: TaskPrioritySchema.optional(),
  dueDate: z.coerce.date().nullable().optional(),
  assigneeUserId: UserIdSchema.optional(),
  assigneeAgentId: AgentIdSchema.optional(),
  ownerUserId: UserIdSchema.optional(),
})

export const UpdateTaskBodySchema = z.object({
  title: NonEmptyStringSchema.optional(),
  purpose: z.string().nullable().optional(),
  detail: z.string().nullable().optional(),
  priority: TaskPrioritySchema.optional(),
  dueDate: z.coerce.date().nullable().optional(),
  archivedAt: z.coerce.date().nullable().optional(),
  storyPoints: z.number().int().min(0).nullable().optional(),
})

// Bulk-archive the org's done tasks; an absent / null olderThanDays archives
// every done task, otherwise only those last touched before the cutoff.
export const ArchiveDoneTasksBodySchema = z.object({
  olderThanDays: z.number().int().positive().nullable().optional(),
})

export const SetTaskIterationBodySchema = z.object({
  iterationId: z.string().uuid().nullable(),
})

// Assignment is to a person (assigneeUserId) or an agent (assigneeAgentId);
// the two are mutually exclusive. Both null/absent clears the assignment.
export const AssignTaskBodySchema = z.object({
  assigneeUserId: UserIdSchema.nullable().optional(),
  assigneeAgentId: AgentIdSchema.nullable().optional(),
})

export const TransitionTaskBodySchema = z.object({
  status: TaskStatusSchema,
})

export const AssignableUserSchema = z.object({
  id: UserIdSchema,
  displayName: NonEmptyStringSchema,
})
export type AssignableUser = z.infer<typeof AssignableUserSchema>

export const MoveTaskBodySchema = z.object({
  columnId: z.string().uuid(),
})

// ─── Boards (per-project columns + style) ─────────────────────────────────

export const BoardStyleSchema = z.enum(['kanban', 'scrum'])
export type BoardStyle = z.infer<typeof BoardStyleSchema>

export const ColumnCategorySchema = z.enum(['todo', 'in_progress', 'review', 'done'])
export type ColumnCategory = z.infer<typeof ColumnCategorySchema>

export const BoardColumnRecordSchema = z.object({
  id: z.string().uuid(),
  projectId: ProjectIdSchema,
  name: NonEmptyStringSchema,
  category: ColumnCategorySchema,
  position: z.number().int(),
})
export type BoardColumnRecord = z.infer<typeof BoardColumnRecordSchema>

export const ProjectBoardRecordSchema = z.object({
  style: BoardStyleSchema,
  columns: BoardColumnRecordSchema.array(),
})
export type ProjectBoardRecord = z.infer<typeof ProjectBoardRecordSchema>

export const UpdateBoardBodySchema = z.object({
  style: BoardStyleSchema,
})

export const CreateColumnBodySchema = z.object({
  name: NonEmptyStringSchema,
  category: ColumnCategorySchema,
  position: z.number().int().optional(),
})

export const UpdateColumnBodySchema = z.object({
  name: NonEmptyStringSchema.optional(),
  category: ColumnCategorySchema.optional(),
  position: z.number().int().optional(),
})

// ─── Iterations (scrum sprints) ───────────────────────────────────────────

export const IterationStatusSchema = z.enum(['planned', 'active', 'completed'])
export type IterationStatusValue = z.infer<typeof IterationStatusSchema>

export const IterationRecordSchema = z.object({
  id: z.string().uuid(),
  projectId: ProjectIdSchema,
  name: NonEmptyStringSchema,
  goal: z.string().nullable(),
  status: IterationStatusSchema,
  startDate: z.string().nullable(),
  endDate: z.string().nullable(),
  capacity: z.number().int().nullable(),
  position: z.number().int(),
  completedAt: z.string().nullable(),
  taskCount: z.number().int(),
  pointsTotal: z.number().int(),
  pointsDone: z.number().int(),
})
export type IterationRecord = z.infer<typeof IterationRecordSchema>

export const CreateIterationBodySchema = z.object({
  name: NonEmptyStringSchema,
  goal: z.string().optional(),
  startDate: z.string().optional(),
  endDate: z.string().optional(),
  capacity: z.number().int().positive().optional(),
})

export const UpdateIterationBodySchema = z.object({
  name: NonEmptyStringSchema.optional(),
  goal: z.string().nullable().optional(),
  startDate: z.string().nullable().optional(),
  endDate: z.string().nullable().optional(),
  capacity: z.number().int().positive().nullable().optional(),
  action: z.enum(['start', 'complete']).optional(),
})

export const ProjectInsightsRecordSchema = z.object({
  velocity: z
    .object({ iterationId: z.string().uuid(), name: z.string(), points: z.number() })
    .array(),
  burndown: z
    .object({
      iterationId: z.string().uuid(),
      name: z.string(),
      totalPoints: z.number(),
      days: z
        .object({ date: z.string(), remaining: z.number(), ideal: z.number() })
        .array(),
    })
    .nullable(),
})
export type ProjectInsightsRecord = z.infer<typeof ProjectInsightsRecordSchema>
