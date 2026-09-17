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

/**
 * The two visibilities a person may choose, for a project or a channel.
 *
 * `private` is deliberately absent. It remains in the stored
 * `ChannelVisibility` enum — six migrations' CHECK constraints and two
 * PL/pgSQL functions require the literal for every DM and system-managed
 * surface — but it is never user-selectable, never offered in a create form and
 * never accepted from a request body. A person choosing "not everyone" gets
 * `protected`, which is discoverable and has a member list; `private` means
 * "this is a direct message", which is not a choice a create form can make.
 */
export const SelectableVisibilitySchema = z.enum(['public', 'protected'])
export type SelectableVisibility = z.infer<typeof SelectableVisibilitySchema>

// sp-channels: body for PATCH /api/channels/:channelId
export const UpdateChannelBodySchema = z
  .object({
    label: NonEmptyStringSchema.optional(),
    topic: z.string().max(500).nullable().optional(),
    description: z.string().max(2000).nullable().optional(),
    visibility: SelectableVisibilitySchema.optional(),
  })
  .refine(
    (body) =>
      body.label !== undefined
      || body.topic !== undefined
      || body.description !== undefined
      || body.visibility !== undefined,
    {
      message:
        'At least one of label, topic, description, or visibility is required',
    },
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
  projectId: z.string().uuid().optional(),
  // `private` is not accepted here. A DM or system surface is created by the
  // services that own those lifecycles, never by a person posting this body.
  visibility: SelectableVisibilitySchema.optional(),
})

/**
 * `POST /api/projects`. Named rather than inline so the route, the tests and
 * the admin agree on one shape — the inline `z.object({ name, teamId })` it
 * replaces could not carry `visibility` without being re-spelled per caller.
 */
export const CreateProjectBodySchema = z.object({
  name: NonEmptyStringSchema,
  teamId: z.string().uuid(),
  visibility: SelectableVisibilitySchema.optional(),
})
export type CreateProjectBody = z.infer<typeof CreateProjectBodySchema>

export const UpdateProjectBodySchema = z.object({
  name: NonEmptyStringSchema.optional(),
  // What the project is for. Readable by everybody in the organisation through
  // the project directory, so it is written by the project's own members.
  description: z.string().trim().max(500).nullable().optional(),
  avatarEmoji: z.string().trim().min(1).max(32).nullable().optional(),
  avatarAttachmentId: z.string().uuid().nullable().optional(),
  visibility: SelectableVisibilitySchema.optional(),
}).refine(
  (body) => body.name !== undefined
    || body.description !== undefined
    || body.avatarEmoji !== undefined
    || body.avatarAttachmentId !== undefined
    || body.visibility !== undefined,
  { message: 'At least one project field is required' },
)

export const AddChannelMemberBodySchema = z.object({
  userId: UserIdSchema,
})

// `GET /api/channels/:channelId/mention-audience?userIds=a,b` — which of the
// people a draft @mentions cannot read the channel, asked before sending.
export const MAX_MENTION_AUDIENCE_USER_IDS = 50

export const ChannelMentionAudienceUserIdsSchema = z
  .array(UserIdSchema)
  .min(1)
  .max(MAX_MENTION_AUDIENCE_USER_IDS)

export const ChannelMentionAudienceRecordSchema = z.object({
  outsiderUserIds: z.array(UserIdSchema),
  viewerCanAddMembers: z.boolean(),
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
