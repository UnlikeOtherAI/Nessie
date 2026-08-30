import { z } from 'zod'

import { TimestampSchema } from './shared.js'

// Persistent recipient-private attention. Every kind is revalidated against
// its linked resource before it is returned or counted.
export const UserAlertKindSchema = z.enum(['mention', 'task_assigned', 'knowledge_published'])
export type UserAlertKind = z.infer<typeof UserAlertKindSchema>

export const UserAlertRecordSchema = z.object({
  id: z.string().uuid(),
  kind: UserAlertKindSchema,
  messageId: z.string().uuid().nullable(),
  rootMessageId: z.string().uuid().nullable(),
  threadId: z.string().uuid().nullable(),
  channelId: z.string().uuid().nullable(),
  channelLabel: z.string().nullable(),
  projectId: z.string().uuid().nullable(),
  taskId: z.string().uuid().nullable(),
  knowledgePageId: z.string().uuid().nullable(),
  actorUserId: z.string().uuid().nullable(),
  actorAgentId: z.string().uuid().nullable(),
  actorDisplayName: z.string().nullable(),
  readAt: TimestampSchema.nullable(),
  createdAt: TimestampSchema,
})
export type UserAlertRecord = z.infer<typeof UserAlertRecordSchema>

export const ListAlertsResponseSchema = z.object({
  alerts: z.array(UserAlertRecordSchema),
  unreadCount: z.number().int().nonnegative(),
})
export type ListAlertsResponse = z.infer<typeof ListAlertsResponseSchema>

export const AttentionSummarySchema = z.object({
  assignedWork: z.object({
    projects: z.record(z.string().uuid(), z.number().int().nonnegative()),
    total: z.number().int().nonnegative(),
    versions: z.record(z.string().uuid(), z.string().min(1)),
  }),
  knowledge: z.object({
    projects: z.record(z.string().uuid(), z.number().int().nonnegative()),
    total: z.number().int().nonnegative(),
    versions: z.record(z.string().uuid(), z.string().min(1)),
  }),
  unreadCount: z.number().int().nonnegative(),
})
export type AttentionSummary = z.infer<typeof AttentionSummarySchema>

const AttentionSurfaceReadSchema = z.object({
  kind: z.enum(['task_assigned', 'knowledge_published']),
  projectId: z.string().uuid(),
})

export const MarkAlertsReadBodySchema = z
  .object({
    ids: z.array(z.string().uuid()).max(200).optional(),
    all: z.boolean().optional(),
    surface: AttentionSurfaceReadSchema.optional(),
  })
  .refine((value) => {
    const targets = [
      value.all === true,
      value.ids !== undefined && value.ids.length > 0,
      value.surface !== undefined,
    ].filter(Boolean)
    return targets.length === 1
  }, {
    message: 'Provide alert ids, all: true, or a project surface',
  })
export type MarkAlertsReadBody = z.infer<typeof MarkAlertsReadBodySchema>

export const MarkAlertsReadResponseSchema = z.object({
  read: z.number().int().nonnegative(),
  unreadCount: z.number().int().nonnegative(),
})
export type MarkAlertsReadResponse = z.infer<typeof MarkAlertsReadResponseSchema>
