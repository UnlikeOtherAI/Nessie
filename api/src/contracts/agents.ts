import {
  AgentAvatarBackgroundColorSchema,
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
  avatarAttachmentId: z.string().uuid().optional(),
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
  avatarBackgroundColor: AgentAvatarBackgroundColorSchema.optional(),
})

// The image is stored as a normal private attachment. It becomes visible to
// the wider workspace only after the owner confirms it as the agent's avatar.
export const GeneratedAgentAvatarSchema = z.object({
  avatarAttachmentId: z.string().uuid(),
  avatarBackgroundColor: AgentAvatarBackgroundColorSchema,
})

// Draft fields are accepted for regeneration so the preview can reflect edits
// still open in Agent Designer. They never update the agent themselves.
export const GenerateAgentAvatarBodySchema = z.object({
  name: NonEmptyStringSchema.optional(),
  role: NonEmptyStringSchema.optional(),
  systemPrompt: z.string().optional(),
  // Free-text guidance the person typed for this generation ("a friendly robot
  // in a hard hat"). Optional; the prompt writer honours it within the fixed
  // safety constraints.
  instructions: z.string().max(1_000).optional(),
})

export const CreateAgentBindingBodySchema = z.object({
  channelId: ChannelIdSchema,
  /** Original @mention to replay after a successful invitation. */
  triggerMessageId: z.string().uuid().optional(),
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
