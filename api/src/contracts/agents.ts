import {
  AgentAvatarBackgroundColorSchema,
  AgentEffortSchema,
  AgentIdSchema,
  AgentRecordSchema,
  AgentRunLimitsSchema,
  AgentSpeakingStyleSchema,
  AgentVisibilitySchema,
  ChannelIdSchema,
  PersonalAssistantConfigSummarySchema,
  ThreadIdSchema,
  VoiceNameSchema,
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
//
// `routingProfileId` is deliberately absent. `Agent.routingProfileId` is a
// server/bootstrap-only column (docs/plans/2026-09-02-agent-designer-global-agent.md
// → the parameter map): no client sends it, `UpdateAgentBodySchema` does not
// accept it, `createAgentRecord` has no such input, and the run path passes a
// hardcoded `null` rather than reading the column. Accepting it here promised a
// persistence the route never performed. Attaching a routing profile to an
// agent is a control-plane capability that does not exist yet; when it ships it
// arrives with its own authorized write path, not as a silently dropped field.
export const CreateAgentBodySchema = z.object({
  avatarAttachmentId: z.string().uuid().optional(),
  name: NonEmptyStringSchema,
  role: NonEmptyStringSchema.optional(),
  systemPrompt: z.string().optional(),
  parentAgentId: z.string().optional(),
  toolPolicy: z.record(z.string(), z.boolean()).optional(),
  provider: z.string().optional(),
  model: z.string().optional(),
  /**
   * Which linked personal subscription this agent spends, when `provider` is a
   * `subscription/<key>` value. Explicit because a person may link two accounts
   * at one provider and the (provider, model) pair cannot tell them apart.
   */
  modelSubscriptionId: z.string().uuid().nullish(),
  effort: AgentEffortSchema.optional(),
  runLimits: AgentRunLimitsSchema.nullish(),
  visibility: AgentVisibilitySchema.optional(),
  todosEnabled: z.boolean().optional(),
  // The voice a call is spoken in, and how the agent talks in every surface.
  // Both nullable: `null` is "back to the deployment default" / "no style",
  // which is a choice a person can make and `undefined` cannot express.
  voiceName: VoiceNameSchema.nullish(),
  speakingStyle: AgentSpeakingStyleSchema.nullish(),
})

export const UpdateAgentBodySchema = z.object({
  name: NonEmptyStringSchema.optional(),
  /**
   * Reassign stewardship. `null` returns the agent to the unowned pool.
   *
   * Gated by the route's existing `requireOwner` — deliberately NOT widened to
   * let an agent's own steward transfer it, because this endpoint also mutates
   * the system prompt, tool policy and run limits, and one gate cannot serve
   * both without handing every steward those powers too.
   *
   * No acceptance step: today ownership decides visibility and attribution
   * only. When escalation delivery ships, ownership becomes its first rung and
   * a transfer starts routing interruptions to the recipient — at which point
   * this needs a pending-transfer state before it can stay unilateral. See
   * docs/plans/2026-08-29-people-and-their-agents.md.
   */
  ownerUserId: z.string().uuid().nullish(),
  role: NonEmptyStringSchema.optional(),
  systemPrompt: z.string().optional(),
  toolPolicy: z.record(z.string(), z.boolean()).optional(),
  provider: z.string().optional(),
  model: z.string().optional(),
  /**
   * Which linked personal subscription this agent spends, when `provider` is a
   * `subscription/<key>` value. Explicit because a person may link two accounts
   * at one provider and the (provider, model) pair cannot tell them apart.
   */
  modelSubscriptionId: z.string().uuid().nullish(),
  effort: AgentEffortSchema.optional(),
  runLimits: AgentRunLimitsSchema.nullish(),
  todosEnabled: z.boolean().optional(),
  voiceName: VoiceNameSchema.nullish(),
  speakingStyle: AgentSpeakingStyleSchema.nullish(),
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
  // in a hard hat"). Optional; the prompt writer appends it to the agent's
  // purpose within the fixed safety constraints.
  instructions: z.string().max(1_000).optional(),
})

export const CreateAgentBindingBodySchema = z.object({
  channelId: ChannelIdSchema,
  /** Original @mention to replay after a successful invitation. */
  triggerMessageId: z.string().uuid().optional(),
  /**
   * Accepts that the channel's members inherit whatever this agent's browser
   * is signed in to. Only consulted when there is something to inherit, and
   * only after the refusal has named the services.
   */
  confirmBrowserSharing: z.boolean().optional(),
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

// A global agent's per-user home DM (the Agent Designer's chat). The reply
// carries the channel record so a client can patch its cached channel list and
// navigate in one step, exactly as the PA bootstrap reply does.
export const GlobalAgentHomeResponseSchema = z.object({
  agentId: AgentIdSchema,
  channel: ChannelRecordSchema,
  threadId: ThreadIdSchema,
})
export type GlobalAgentHomeResponse = z.infer<typeof GlobalAgentHomeResponseSchema>

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
