import {
  AgentIdSchema,
  ProjectIdSchema,
  TaskFieldValuesPatchSchema,
  TaskPrioritySchema,
  TaskRecordSchema,
  TaskStatusSchema,
  UserIdSchema,
  type TaskPriority,
  type TaskRecord,
} from '@nessie/schemas'
import { z } from 'zod'

import { NonEmptyStringSchema } from './shared.js'

// ─── Tasks (human work distribution) ──────────────────────────────────────
//
// The task record the admin renders directly lives in `@nessie/schemas`
// (`task-records.ts`) because the admin has no import path into `api/src`.
// Re-exported here so route modules keep one contract import.
export { TaskPrioritySchema, TaskRecordSchema, type TaskPriority, type TaskRecord }

export const CreateTaskBodySchema = z.object({
  title: NonEmptyStringSchema,
  purpose: z.string().optional(),
  detail: z.string().optional(),
  projectId: ProjectIdSchema.optional(),
  // The board the card lands on. Absent means the project's default board,
  // which is what every caller that has no board on screen wants.
  boardId: z.string().uuid().optional(),
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
  // A partial merge of custom field values; a key set to `null` clears it.
  fieldValues: TaskFieldValuesPatchSchema.optional(),
})

// Archive completed work from one explicit project, and — when the caller is a
// board's own Done column — one explicit board. A board action must never
// silently affect another board, or another project in the same organisation.
export const ArchiveDoneTasksBodySchema = z.object({
  projectId: ProjectIdSchema,
  boardId: z.string().uuid().optional(),
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
  // Target index within the destination column (0 = top). Omitted = append.
  position: z.number().int().nonnegative().optional(),
})

// ─── Boards ───────────────────────────────────────────────────────────────
//
// Board shapes live in `@nessie/schemas` (`boards.ts`, `board-lifecycle.ts`)
// because the worker's ticket tools and the admin read them too. Re-exported
// here so route modules keep one contract import.

export {
  BOARD_TASK_LIMIT,
  BoardColumnRecordSchema,
  BoardFilterSchema,
  BoardRecordSchema,
  BoardStyleSchema,
  ColumnCategorySchema,
  CreateBoardBodySchema,
  CreateBoardColumnBodySchema,
  UpdateBoardBodySchema,
  UpdateBoardColumnBodySchema,
  type BoardColumnRecord,
  type BoardFilter,
  type BoardRecord,
  type BoardStyle,
  type ColumnCategory,
} from '@nessie/schemas'

export {
  CreateTaskFieldBodySchema,
  TaskFieldDefinitionRecordSchema,
  TaskFieldTypeSchema,
  UpdateTaskFieldBodySchema,
  type TaskFieldDefinitionRecord,
  type TaskFieldType,
} from '@nessie/schemas'

/** A task as one board renders it: the record plus its resolved placement. */
export const BoardTaskRecordSchema = TaskRecordSchema.extend({
  columnId: z.string().uuid().nullable(),
  position: z.number().int().nullable(),
})
export type BoardTaskRecord = z.infer<typeof BoardTaskRecordSchema>

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
