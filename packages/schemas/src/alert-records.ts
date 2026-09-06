import { z } from 'zod'

import { TimestampSchema } from './schema-primitives.js'

/**
 * Persistent recipient-private attention. Every kind is revalidated against
 * its linked resource before it is returned or counted.
 *
 * Lives here — not `api/src/contracts/alerts.ts` — because the admin (which
 * renders every alert kind, including `call_missed`'s click-through) has no
 * import path into `api/src`; the API contract file re-exports this schema
 * so route handlers keep one import surface (docs/architecture.md, "shared
 * runtime schemas").
 */
export const UserAlertKindSchema = z.enum([
  'mention',
  'task_assigned',
  'knowledge_published',
  // A scheduled trigger became non-runnable. Durable rather than push-only: the
  // failure this surfaces was previously invisible unless somebody opened the
  // Triggers page and read a delivery row.
  'trigger_health',
  'approval_requested',
  'call_missed',
  'team_invitation',
  // An automatic-membership rule's authorization stopped verifying, so nobody
  // new is being added to its team. Durable for the same reason as
  // trigger_health: otherwise it is visible only to whoever happens to open the
  // Automatic logins tab.
  'automatic_membership_health',
  // A project board's external source stopped syncing. Durable for the same
  // reason as the two above: a board that has quietly stopped updating still
  // looks exactly like a board.
  'board_source_health',
  // A ticket moved or changed on a board this person watches. Durable because
  // somebody explicitly asked to be told: a push is missable, the bell is not.
  'board_ticket_changed',
])
export type UserAlertKind = z.infer<typeof UserAlertKindSchema>

export const TeamInvitationAlertMetadataSchema = z.object({
  inviteId: z.string().min(1),
  organizationId: z.string().min(1),
  teamId: z.string().min(1),
  teamName: z.string().min(1),
  invitedBy: z.string().min(1).optional(),
  expiresAt: TimestampSchema.optional(),
}).strict()
export type TeamInvitationAlertMetadata = z.infer<
  typeof TeamInvitationAlertMetadataSchema
>

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
  triggerId: z.string().uuid().nullable(),
  boardSourceId: z.string().uuid().nullable(),
  callId: z.string().uuid().nullable(),
  metadata: TeamInvitationAlertMetadataSchema.nullable(),
  actorUserId: z.string().uuid().nullable(),
  actorAgentId: z.string().uuid().nullable(),
  actorDisplayName: z.string().nullable(),
  readAt: TimestampSchema.nullable(),
  createdAt: TimestampSchema,
})
export type UserAlertRecord = z.infer<typeof UserAlertRecordSchema>
