import {
  AgentIdSchema,
  ChannelIdSchema,
  TeamIdSchema,
  UserIdSchema,
} from '@nessie/schemas'
import { z } from 'zod'

import { NonEmptyStringSchema, TimestampSchema } from './shared.js'

// The channel, project and team records are produced by
// `@nessie/team-admin`, which the worker also uses, so their schemas live
// in `@nessie/schemas`.
export {
  ChannelRecordSchema,
  ProjectRecordSchema,
  TeamRecordSchema,
  type ChannelRecord,
  type PersonalAssistantPresenceParticipant,
  type ProjectRecord,
  type TeamRecord,
} from '@nessie/schemas'

// sp-channels: body for PATCH /api/channels/:channelId
export const UpdateChannelBodySchema = z
  .object({
    label: NonEmptyStringSchema.optional(),
    topic: z.string().max(500).nullable().optional(),
    description: z.string().max(2000).nullable().optional(),
  })
  .refine(
    (body) =>
      body.label !== undefined
      || body.topic !== undefined
      || body.description !== undefined,
    { message: 'At least one of label, topic, or description is required' },
  )
export type UpdateChannelBody = z.infer<typeof UpdateChannelBodySchema>

export const ProjectMemberRecordSchema = z.object({
  userId: UserIdSchema,
  displayName: z.string(),
  email: z.string(),
  role: z.string(),
})
export type ProjectMemberRecord = z.infer<typeof ProjectMemberRecordSchema>

export const CallParticipantRecordSchema = z.object({
  userId: UserIdSchema,
  displayName: z.string(),
  joinedAt: TimestampSchema,
  leftAt: TimestampSchema.nullable(),
})

export const CallInviteRecordSchema = z.object({
  userId: UserIdSchema,
  displayName: z.string(),
  state: z.enum(['ringing', 'accepted', 'declined', 'missed', 'cancelled']),
  respondedAt: TimestampSchema.nullable(),
})

export const CallRecordSchema = z.object({
  id: z.string().uuid(),
  channelId: ChannelIdSchema,
  channelName: z.string(),
  roomId: z.string().nullable(),
  provider: z.enum(['google_meet', 'jitsi', 'microsoft_teams', 'jitsi_embedded']),
  meetingUri: z.string().url().nullable(),
  status: z.enum(['ringing', 'active', 'ended', 'missed', 'declined', 'cancelled']),
  startedById: UserIdSchema,
  startedByDisplayName: z.string(),
  startedAt: TimestampSchema,
  ringExpiresAt: TimestampSchema.nullable(),
  endedAt: TimestampSchema.nullable(),
  revision: z.number().int().nonnegative(),
  participants: z.array(CallParticipantRecordSchema),
  invites: z.array(CallInviteRecordSchema),
})
export type CallRecord = z.infer<typeof CallRecordSchema>

export const EmptyBodySchema = z.object({})

export const CreateChannelBodySchema = z.object({
  label: NonEmptyStringSchema,
  // An organization-wide channel is explicitly requested by the standalone
  // Channels surface. Omitting it preserves the existing current-team default
  // for project-scoped creation and personal-assistant tools.
  scope: z.enum(['standalone']).optional(),
  teamId: TeamIdSchema.optional(),
  visibility: z.enum(['public', 'protected', 'private']).optional(),
})

export const UpdateProjectBodySchema = z.object({
  name: NonEmptyStringSchema.optional(),
  avatarEmoji: z.string().trim().min(1).max(32).nullable().optional(),
  avatarAttachmentId: z.string().uuid().nullable().optional(),
}).refine(
  (body) => body.name !== undefined || body.avatarEmoji !== undefined || body.avatarAttachmentId !== undefined,
  { message: 'At least one project field is required' },
)

export const AddChannelMemberBodySchema = z.object({
  userId: UserIdSchema,
})

// POST always uses the caller as the PA principal. DELETE accepts a principal
// only so a channel manager can remove another member's already-consented
// presence; a member may still remove only their own.
export const DeletePersonalAssistantPresenceBodySchema = z.object({
  principalUserId: UserIdSchema.optional(),
})

export const StartChannelConversationBodySchema = z
  .object({
    agentIds: z.array(AgentIdSchema).optional().default([]),
    userIds: z.array(UserIdSchema).optional().default([]),
  })
  .refine((body) => body.agentIds.length + body.userIds.length > 0, {
    message: 'Choose at least one recipient',
  })
export type StartChannelConversationBody = z.infer<
  typeof StartChannelConversationBodySchema
>
