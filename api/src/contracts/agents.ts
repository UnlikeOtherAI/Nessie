import {
  AgentEffortSchema,
  AgentRecordSchema,
  AgentRunLimitsSchema,
  ChannelIdSchema,
  PersonalAssistantConfigSummarySchema,
} from '@nessie/schemas'
import { z } from 'zod'

import { ThreadRecordSchema } from './messaging.js'
import { NonEmptyStringSchema } from './shared.js'
import { ChannelRecordSchema } from './workspace.js'

export { AgentModelOptionSchema } from '@nessie/schemas'

// The agent record is produced by `@nessie/workspace-admin`, which the worker
// also uses, so its schema lives in `@nessie/schemas`.
export { type AgentRecord } from '@nessie/schemas'
export { AgentRecordSchema }

// `runLimits` is an ordinary agent-edit field (existing authorization, not a
// protected tool-policy key): omit it to leave the stored value untouched, send
// an object to replace it, send `null` to clear every explicit limit.
export const CreateAgentBodySchema = z.object({
  name: NonEmptyStringSchema,
  role: NonEmptyStringSchema.optional(),
  systemPrompt: z.string().optional(),
  parentAgentId: z.string().optional(),
  routingProfileId: z.string().uuid().optional(),
  toolPolicy: z.record(z.string(), z.boolean()).optional(),
  provider: z.string().optional(),
  model: z.string().optional(),
  effort: AgentEffortSchema.optional(),
  runLimits: AgentRunLimitsSchema.nullish(),
})

export const UpdateAgentBodySchema = z.object({
  name: NonEmptyStringSchema.optional(),
  role: NonEmptyStringSchema.optional(),
  systemPrompt: z.string().optional(),
  toolPolicy: z.record(z.string(), z.boolean()).optional(),
  provider: z.string().optional(),
  model: z.string().optional(),
  effort: AgentEffortSchema.optional(),
  runLimits: AgentRunLimitsSchema.nullish(),
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
