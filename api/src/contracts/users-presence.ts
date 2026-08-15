import {
  AgentIdSchema,
  ChannelIdSchema,
  OrganizationIdSchema,
  PushSurfaceSchema,
  ProjectIdSchema,
  UserIdSchema,
} from '@nessie/schemas'
import { z } from 'zod'

import { NonEmptyStringSchema, TimestampSchema } from './shared.js'

// ─── Users ────────────────────────────────────────────────────────────────

export const UserActiveStatusSchema = z.object({
  id: z.string().uuid(),
  label: NonEmptyStringSchema,
  emoji: z.string().nullable(),
  activeNow: z.boolean(),
})
export type UserActiveStatus = z.infer<typeof UserActiveStatusSchema>

// ─── Presence ───────────────────────────────────────────────────────────────

export const PresenceStateSchema = z.enum(['online', 'away', 'offline'])
export type PresenceState = z.infer<typeof PresenceStateSchema>

export const PresenceManualStateSchema = z.enum(['active', 'away'])
export type PresenceManualState = z.infer<typeof PresenceManualStateSchema>

export const PresenceEntrySchema = z.object({
  userId: UserIdSchema,
  state: PresenceStateSchema,
  manualState: PresenceManualStateSchema.nullable(),
  statusId: z.string().uuid().nullable(),
  statusEmoji: z.string().nullable(),
  statusLabel: z.string().nullable(),
})
export type PresenceEntry = z.infer<typeof PresenceEntrySchema>

export const PresenceListResponseSchema = z.object({
  users: z.array(PresenceEntrySchema),
})
export type PresenceListResponse = z.infer<typeof PresenceListResponseSchema>

export const SetManualPresenceBodySchema = z.object({
  state: PresenceManualStateSchema.nullable(),
})
export type SetManualPresenceBody = z.infer<typeof SetManualPresenceBodySchema>

export const PresenceHeartbeatBodySchema = z.object({
  active: z.boolean(),
})
export type PresenceHeartbeatBody = z.infer<typeof PresenceHeartbeatBodySchema>

export const PushSurfaceHeartbeatBodySchema = z.object({
  clientId: z.string().uuid(),
  // JSON has no bigint type. The client sends its strictly-increasing logical
  // clock as a decimal string and the API persists it as PostgreSQL BIGINT.
  sequence: z.string().regex(/^(?:0|[1-9]\d{0,18})$/),
  surface: PushSurfaceSchema.nullable(),
})
export type PushSurfaceHeartbeatBody = z.infer<typeof PushSurfaceHeartbeatBodySchema>

export const UserStatusScheduleKindSchema = z.enum(['date_range', 'weekly'])
export type UserStatusScheduleKind = z.infer<typeof UserStatusScheduleKindSchema>

export const UserStatusRuleScopeSchema = z.enum(['fallback', 'channel', 'project'])
export type UserStatusRuleScope = z.infer<typeof UserStatusRuleScopeSchema>
const StatusLabelSchema = z.string().trim().min(1).max(120)
const StatusInstructionsSchema = z.string().trim().min(1).max(8000)

export const UserStatusScheduleRecordSchema = z.object({
  id: z.string().uuid(),
  statusId: z.string().uuid(),
  kind: UserStatusScheduleKindSchema,
  label: z.string().nullable(),
  enabled: z.boolean(),
  startsAt: TimestampSchema.nullable(),
  endsAt: TimestampSchema.nullable(),
  dayOfWeek: z.number().int().min(0).max(6).nullable(),
  startTime: z.string().nullable(),
  endTime: z.string().nullable(),
  timezone: NonEmptyStringSchema,
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
})
export type UserStatusScheduleRecord = z.infer<
  typeof UserStatusScheduleRecordSchema
>

export const UserStatusRuleRecordSchema = z.object({
  id: z.string().uuid(),
  statusId: z.string().uuid(),
  scope: UserStatusRuleScopeSchema,
  channelId: ChannelIdSchema.nullable(),
  projectId: ProjectIdSchema.nullable(),
  agentId: AgentIdSchema.nullable(),
  agentEnabled: z.boolean(),
  instructions: NonEmptyStringSchema,
  priority: z.number().int(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
})
export type UserStatusRuleRecord = z.infer<typeof UserStatusRuleRecordSchema>

export const UserStatusRecordSchema = z.object({
  id: z.string().uuid(),
  organizationId: OrganizationIdSchema,
  userId: UserIdSchema,
  label: NonEmptyStringSchema,
  emoji: z.string().nullable(),
  isActive: z.boolean(),
  activeNow: z.boolean(),
  agentEnabled: z.boolean(),
  agentInstructions: z.string().nullable(),
  schedules: UserStatusScheduleRecordSchema.array(),
  rules: UserStatusRuleRecordSchema.array(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
})
export type UserStatusRecord = z.infer<typeof UserStatusRecordSchema>

export const CreateUserStatusBodySchema = z.object({
  label: StatusLabelSchema,
  emoji: z.string().max(16).nullable().optional(),
  agentEnabled: z.boolean().optional(),
  agentInstructions: z.string().max(8000).nullable().optional(),
})
export type CreateUserStatusBody = z.infer<typeof CreateUserStatusBodySchema>

export const UpdateUserStatusBodySchema = z.object({
  label: StatusLabelSchema.optional(),
  emoji: z.string().max(16).nullable().optional(),
  agentEnabled: z.boolean().optional(),
  agentInstructions: z.string().max(8000).nullable().optional(),
})
export type UpdateUserStatusBody = z.infer<typeof UpdateUserStatusBodySchema>

const TimeOfDaySchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/)

export const CreateUserStatusScheduleBodySchema = z
  .object({
    kind: UserStatusScheduleKindSchema,
    label: z.string().max(120).nullable().optional(),
    enabled: z.boolean().optional(),
    startsAt: z.string().datetime().nullable().optional(),
    endsAt: z.string().datetime().nullable().optional(),
    dayOfWeek: z.number().int().min(0).max(6).nullable().optional(),
    startTime: TimeOfDaySchema.nullable().optional(),
    endTime: TimeOfDaySchema.nullable().optional(),
    timezone: NonEmptyStringSchema.optional(),
  })
  .superRefine((body, context) => {
    if (body.kind === 'date_range' && (!body.startsAt || !body.endsAt)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Date range schedules require startsAt and endsAt',
      })
    }
    if (
      body.kind === 'weekly' &&
      (body.dayOfWeek === null ||
        body.dayOfWeek === undefined ||
        !body.startTime ||
        !body.endTime)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Weekly schedules require dayOfWeek, startTime, and endTime',
      })
    }
  })
export type CreateUserStatusScheduleBody = z.infer<
  typeof CreateUserStatusScheduleBodySchema
>

export const UpdateUserStatusScheduleBodySchema = z.object({
  label: z.string().max(120).nullable().optional(),
  enabled: z.boolean().optional(),
  startsAt: z.string().datetime().nullable().optional(),
  endsAt: z.string().datetime().nullable().optional(),
  dayOfWeek: z.number().int().min(0).max(6).nullable().optional(),
  startTime: TimeOfDaySchema.nullable().optional(),
  endTime: TimeOfDaySchema.nullable().optional(),
  timezone: NonEmptyStringSchema.optional(),
})
export type UpdateUserStatusScheduleBody = z.infer<
  typeof UpdateUserStatusScheduleBodySchema
>

export const CreateUserStatusRuleBodySchema = z
  .object({
    scope: UserStatusRuleScopeSchema,
    channelId: ChannelIdSchema.nullable().optional(),
    projectId: ProjectIdSchema.nullable().optional(),
    agentId: AgentIdSchema.nullable().optional(),
    agentEnabled: z.boolean().optional(),
    instructions: StatusInstructionsSchema,
    priority: z.number().int().optional(),
  })
  .superRefine((body, context) => {
    if (body.scope === 'channel' && !body.channelId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Channel rules require channelId',
      })
    }
    if (body.scope === 'project' && !body.projectId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Project rules require projectId',
      })
    }
  })
export type CreateUserStatusRuleBody = z.infer<typeof CreateUserStatusRuleBodySchema>

export const UpdateUserStatusRuleBodySchema = z.object({
  scope: UserStatusRuleScopeSchema.optional(),
  channelId: ChannelIdSchema.nullable().optional(),
  projectId: ProjectIdSchema.nullable().optional(),
  agentId: AgentIdSchema.nullable().optional(),
  agentEnabled: z.boolean().optional(),
  instructions: StatusInstructionsSchema.optional(),
  priority: z.number().int().optional(),
})
export type UpdateUserStatusRuleBody = z.infer<typeof UpdateUserStatusRuleBodySchema>

export const UserRecordSchema = z.object({
  id: UserIdSchema,
  email: z.string().email(),
  displayName: NonEmptyStringSchema,
  role: NonEmptyStringSchema,
  // ISO timestamp when this org membership was deactivated, or null/absent when
  // active. Deactivated members keep their row + history but lose access.
  deactivatedAt: TimestampSchema.nullable().optional(),
  channelIds: z.array(ChannelIdSchema),
  activeStatus: UserActiveStatusSchema.nullable().optional(),
  // Avatar sources so member/people lists can render real profile pictures
  // (same precedence as MessageAuthor: UnlikeOtherAI > custom attachment >
  // provider picture > initials).
  avatarUrl: z.string().nullish(),
  avatarAttachmentId: z.string().uuid().nullish(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
})
export type UserRecord = z.infer<typeof UserRecordSchema>

export const CreateUserBodySchema = z.object({
  email: z.string().email(),
  displayName: NonEmptyStringSchema,
  password: z.string().min(8),
  role: NonEmptyStringSchema.optional(),
  channelIds: z.array(ChannelIdSchema).optional(),
})

export const UpdateUserRoleBodySchema = z.object({
  role: NonEmptyStringSchema,
})
