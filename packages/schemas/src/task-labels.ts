import { z } from 'zod'

import { BoardSourceProviderSchema } from './board-sources.js'
import { ProjectIdSchema } from './ids.js'
import { NonEmptyStringSchema, TimestampSchema } from './schema-primitives.js'

/**
 * Ticket labels: board-scoped, coloured, optionally owned by a board source
 * (docs/plans/2026-09-21-ticket-comments-attachments-labels/board-labels-and-attachment-removal.md §8).
 * A ticket's labels are the labels of its home board; a ticket moved to another
 * board keeps them by name.
 *
 * Colour is data on the row, not a theme token — the same carve-out the
 * organisation theme took — so it is a strict lower-case `#rrggbb`.
 */
export const LabelColorSchema = z.string().regex(/^#[0-9a-f]{6}$/, 'expected #rrggbb (lower-case)')
export type LabelColor = z.infer<typeof LabelColorSchema>

/** The colours the picker offers. The first is the default for a new label. */
export const LABEL_PALETTE = [
  '#6b7280', '#ef4444', '#f97316', '#f59e0b', '#eab308', '#22c55e',
  '#14b8a6', '#3b82f6', '#6366f1', '#8b5cf6', '#ec4899', '#a16207',
] as const
export const DEFAULT_LABEL_COLOR: LabelColor = LABEL_PALETTE[0]

export const TASK_LABEL_NAME_MAX_CHARS = 60
export const TaskLabelNameSchema = NonEmptyStringSchema.max(TASK_LABEL_NAME_MAX_CHARS)

export const TaskLabelSummarySchema = z.object({
  id: z.string().uuid(),
  name: TaskLabelNameSchema,
  color: LabelColorSchema,
  /** True when a board source owns it; the dialog and the tools say so. */
  external: z.boolean(),
})
export type TaskLabelSummary = z.infer<typeof TaskLabelSummarySchema>

/**
 * The summary a `TaskRecord` and a card carry is unchanged: a pill never asks
 * which board its label is on — it is the task's board.
 */
export const TaskLabelRecordSchema = TaskLabelSummarySchema.extend({
  projectId: ProjectIdSchema,
  /** The board the label belongs to; its name is unique on that board. */
  boardId: z.string().uuid(),
  source: z
    .object({
      sourceId: z.string().uuid(),
      provider: BoardSourceProviderSchema,
      externalId: z.string(),
    })
    .nullable(),
  /** Present on the settings read only. */
  taskCount: z.number().int().optional(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
})
export type TaskLabelRecord = z.infer<typeof TaskLabelRecordSchema>

export const CreateTaskLabelBodySchema = z
  .object({
    name: TaskLabelNameSchema,
    color: LabelColorSchema.optional(),
  })
  .strict()
export type CreateTaskLabelBody = z.infer<typeof CreateTaskLabelBodySchema>

export const UpdateTaskLabelBodySchema = z
  .object({
    name: TaskLabelNameSchema.optional(),
    color: LabelColorSchema.optional(),
  })
  .strict()
export type UpdateTaskLabelBody = z.infer<typeof UpdateTaskLabelBodySchema>

export const TASK_LABELS_PER_TASK_MAX = 50

/** Replace-set semantics on a task; order is irrelevant, duplicates refused. */
export const TaskLabelIdsSchema = z
  .array(z.string().uuid())
  .max(TASK_LABELS_PER_TASK_MAX)
  .refine((ids) => new Set(ids).size === ids.length, 'duplicate label id')

/** The uniqueness key: "Bug" and " bug " are one label on a board. */
export const normalizeLabelName = (name: string): string => name.trim().toLowerCase()
