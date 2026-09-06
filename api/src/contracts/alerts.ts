import {
  TeamInvitationAlertMetadataSchema,
  UserAlertKindSchema,
  UserAlertRecordSchema,
  type TeamInvitationAlertMetadata,
  type UserAlertKind,
  type UserAlertRecord,
} from '@nessie/schemas'
import { z } from 'zod'

// The alert record the admin renders directly lives in `@nessie/schemas`
// (`alert-records.ts`) because the admin has no import path into `api/src`.
// Re-exported here so route modules keep one contract import.
export {
  TeamInvitationAlertMetadataSchema,
  UserAlertKindSchema,
  UserAlertRecordSchema,
  type TeamInvitationAlertMetadata,
  type UserAlertKind,
  type UserAlertRecord,
}

// The page itself. `meta` carries the cursors and the total; the unread count
// is `GET /api/alerts/summary`'s answer, not a field smuggled into a page.
export const ListAlertsResponseSchema = z.array(UserAlertRecordSchema)
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
