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
  }),
  knowledge: z.object({
    projects: z.record(z.string().uuid(), z.number().int().nonnegative()),
    total: z.number().int().nonnegative(),
  }),
  unreadCount: z.number().int().nonnegative(),
})
export type AttentionSummary = z.infer<typeof AttentionSummarySchema>

export const MarkAlertsReadBodySchema = z
  .object({
    ids: z.array(z.string().uuid()).max(200).optional(),
    all: z.boolean().optional(),
  })
  .refine((value) => value.all === true || (value.ids !== undefined && value.ids.length > 0), {
    message: 'Provide alert ids or all: true',
  })
export type MarkAlertsReadBody = z.infer<typeof MarkAlertsReadBodySchema>

export const MarkAlertsReadResponseSchema = z.object({
  read: z.number().int().nonnegative(),
  unreadCount: z.number().int().nonnegative(),
})
export type MarkAlertsReadResponse = z.infer<typeof MarkAlertsReadResponseSchema>
