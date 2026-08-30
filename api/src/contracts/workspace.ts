import {
  AgentIdSchema,
  ChannelIdSchema,
  OrganizationIdSchema,
  ProjectIdSchema,
  TeamIdSchema,
  UserIdSchema,
} from '@nessie/schemas'
import { z } from 'zod'

import { NonEmptyStringSchema, TimestampSchema } from './shared.js'

// The channel record is produced by `@nessie/workspace-admin`, which the worker
// also uses, so its schema lives in `@nessie/schemas`.
export { ChannelRecordSchema, type ChannelRecord } from '@nessie/schemas'

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

export const ProjectRecordSchema = z.object({
  id: ProjectIdSchema,
  name: NonEmptyStringSchema,
  avatarEmoji: z.string().min(1).max(32).nullable(),
  avatarAttachmentId: z.string().uuid().nullable(),
  organizationId: OrganizationIdSchema,
  memberCount: z.number().int().nonnegative(),
  teamCount: z.number().int().nonnegative().optional(),
  channelCount: z.number().int().nonnegative().optional(),
  createdAt: TimestampSchema,
})
export type ProjectRecord = z.infer<typeof ProjectRecordSchema>

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

export const CallRecordSchema = z.object({
  id: z.string().uuid(),
  channelId: ChannelIdSchema,
  roomId: z.string(),
  status: z.enum(['active', 'ended']),
  startedById: UserIdSchema,
  startedAt: TimestampSchema,
  endedAt: TimestampSchema.nullable(),
  participants: z.array(CallParticipantRecordSchema),
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
