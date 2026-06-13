import {
  ChannelIdSchema,
  OrganizationIdSchema,
  ProjectIdSchema,
  TeamIdSchema,
  ThreadIdSchema,
  UserIdSchema,
} from '@nessie/schemas'
import { z } from 'zod'

import { NonEmptyStringSchema, TimestampSchema } from './shared.js'

export const ChannelRecordSchema = z.object({
  id: ChannelIdSchema,
  label: NonEmptyStringSchema,
  slug: z.string().nullish(),
  type: z.enum(['standard', 'dm']),
  systemChannelType: z.enum(['personal_assistant']).optional(),
  dmUserId: UserIdSchema.nullish(),
  visibility: z.enum(['public', 'protected', 'private']),
  organizationId: OrganizationIdSchema,
  projectId: ProjectIdSchema,
  projectName: NonEmptyStringSchema,
  teamId: TeamIdSchema,
  teamName: NonEmptyStringSchema,
  defaultThreadId: ThreadIdSchema,
  unreadCount: z.number().int().nonnegative(),
  // sp-channels: channel lifecycle fields
  topic: z.string().nullish(),
  description: z.string().nullish(),
  archivedAt: TimestampSchema.nullish(),
  memberRole: z.enum(['owner', 'admin', 'member', 'viewer']).nullish(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
})
export type ChannelRecord = z.infer<typeof ChannelRecordSchema>

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
  teamId: TeamIdSchema.optional(),
  visibility: z.enum(['public', 'protected', 'private']).optional(),
})

export const UpdateProjectBodySchema = z.object({
  name: NonEmptyStringSchema,
})

export const AddChannelMemberBodySchema = z.object({
  userId: UserIdSchema,
})
