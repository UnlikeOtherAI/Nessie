import {
  AgentIdSchema,
  AgentStatusSchema,
  ChannelIdSchema,
  PersonalAssistantConfigSummarySchema,
  RunIdSchema,
} from '@nessie/schemas'
import { z } from 'zod'

import { ThreadRecordSchema } from './messaging.js'
import { NonEmptyStringSchema, TimestampSchema } from './shared.js'
import { ChannelRecordSchema } from './workspace.js'

export const AgentRecordSchema = z.object({
  id: AgentIdSchema,
  name: NonEmptyStringSchema,
  role: NonEmptyStringSchema,
  status: AgentStatusSchema,
  agentKind: z.enum(['shared', 'personal_assistant']).optional(),
  systemManaged: z.boolean().optional(),
  surfacePolicy: z.enum(['shared', 'dm_only']).optional(),
  delegationMode: z.enum(['none', 'act_as_requesting_user']).optional(),
  currentRunId: RunIdSchema.optional(),
  currentToolName: z.string().optional(),
  currentToolStartedAt: TimestampSchema.optional(),
  lastActivityAt: TimestampSchema,
  systemPrompt: z.string().optional(),
  parentAgentId: AgentIdSchema.nullish(),
  provider: z.string().optional(),
  model: z.string().optional(),
  avatarAttachmentId: z.string().uuid().nullish(),
  routingProfileId: z.string().uuid().optional(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
  channelIds: z.array(ChannelIdSchema),
})
export type AgentRecord = z.infer<typeof AgentRecordSchema>

export const CreateAgentBodySchema = z.object({
  name: NonEmptyStringSchema,
  role: NonEmptyStringSchema.optional(),
  systemPrompt: z.string().optional(),
  parentAgentId: z.string().optional(),
  routingProfileId: z.string().uuid().optional(),
  toolPolicy: z.record(z.string(), z.boolean()).optional(),
  provider: z.string().optional(),
  model: z.string().optional(),
})

export const UpdateAgentBodySchema = z.object({
  name: NonEmptyStringSchema.optional(),
  role: NonEmptyStringSchema.optional(),
  systemPrompt: z.string().optional(),
  toolPolicy: z.record(z.string(), z.boolean()).optional(),
  provider: z.string().optional(),
  model: z.string().optional(),
})

export const UpdateAgentAvatarBodySchema = z.object({
  avatarAttachmentId: z.string().uuid().nullable(),
})

export const CreateAgentBindingBodySchema = z.object({
  channelId: ChannelIdSchema,
})

export const PersonalAssistantStateResponseSchema = z.object({
  agent: AgentRecordSchema.nullable(),
  channel: ChannelRecordSchema.nullable(),
  instance: z.null().optional(),
  thread: ThreadRecordSchema.nullable().optional(),
  configSummary: PersonalAssistantConfigSummarySchema.optional(),
})
export type PersonalAssistantStateResponse = z.infer<
  typeof PersonalAssistantStateResponseSchema
>

export const PersonalAssistantBootstrapResponseSchema = z.object({
  agent: AgentRecordSchema,
  channel: ChannelRecordSchema,
  instance: z.null().optional(),
  thread: ThreadRecordSchema,
  configSummary: PersonalAssistantConfigSummarySchema.optional(),
})
export type PersonalAssistantBootstrapResponse = z.infer<
  typeof PersonalAssistantBootstrapResponseSchema
>
