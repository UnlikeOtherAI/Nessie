import { z } from 'zod'

import { TaskIdSchema } from './ids.js'
import { TimestampSchema } from './schema-primitives.js'

export const TaskChecklistStepRecordSchema = z.object({
  id: z.string().uuid(),
  key: z.string().min(1),
  title: z.string().min(1),
  instructions: z.string(),
  completedAt: TimestampSchema.nullable(),
  result: z.string().nullable(),
})

export const TaskChecklistRecordSchema = z.object({
  id: z.string().uuid(),
  taskId: TaskIdSchema,
  title: z.string().min(1),
  steps: TaskChecklistStepRecordSchema.array(),
})

export const ApplyTaskChecklistBodySchema = z.object({
  agentId: z.string().uuid(),
  templateId: z.string().uuid(),
})

export const UpdateTaskChecklistStepBodySchema = z.object({
  completed: z.boolean(),
  result: z.string().max(10_000).nullable().optional(),
})

export type TaskChecklistRecord = z.infer<typeof TaskChecklistRecordSchema>
