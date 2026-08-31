import { z } from 'zod'

import {
  AgentEffortSchema,
  AgentRunLimitsSchema,
  AgentStatusSchema,
  AgentTriggerTypeSchema,
  SystemChannelTypeSchema,
} from './lifecycle.js'
import {
  AgentIdSchema,
  ChannelIdSchema,
  OrganizationIdSchema,
  ProjectIdSchema,
  RunIdSchema,
  TeamIdSchema,
  ThreadIdSchema,
  UserIdSchema,
} from './ids.js'
import { NonEmptyStringSchema, TimestampSchema } from './schema-primitives.js'

/**
 * Records the API returns for channels, agents, and triggers.
 *
 * They live here rather than in `api/src/contracts` because the services that
 * produce them (`@nessie/workspace-admin`) are shared with the worker: the
 * personal assistant creates a channel, an agent, a binding, or a trigger
 * through the very same functions the routes call, so both sides have to agree
 * on the shape those functions return. `api/src/contracts` re-exports them, so
 * routes and admin-facing contracts are unchanged.
 */

// A shared-channel Personal Assistant is one organization agent with a
// per-member binding. This is the intentionally minimal projection channel
// peers receive for that binding; it never exposes the singleton's prompt,
// policy, limits, or channel list.
export const PersonalAssistantPresenceParticipantSchema = z.object({
  id: z.string().uuid(),
  agentId: AgentIdSchema,
  principalUserId: UserIdSchema,
  displayName: z.string(),
  // The canonical stored token is public for every reader. Only rendering
  // projects it to `Personal Assistant` for its owner.
  mentionName: z.string(),
  avatarAttachmentId: z.string().uuid().nullish(),
  isPersonalAssistant: z.literal(true),
})
export type PersonalAssistantPresenceParticipant = z.infer<
  typeof PersonalAssistantPresenceParticipantSchema
>

export const ChannelRecordSchema = z.object({
  id: ChannelIdSchema,
  label: NonEmptyStringSchema,
  slug: z.string().nullish(),
  type: z.enum(['standard', 'dm']),
  systemChannelType: SystemChannelTypeSchema.optional(),
  dmUserId: UserIdSchema.nullish(),
  // Group DMs are private conversations with multiple human and/or agent
  // recipients. They share the channel storage model, but must be surfaced in
  // Direct messages rather than a project channel list.
  isGroupDm: z.boolean().optional(),
  visibility: z.enum(['public', 'protected', 'private']),
  organizationId: OrganizationIdSchema,
  // Standalone channels are organization-wide. Their hidden system container
  // exists only to preserve the channel/team relational model; it is never a
  // user-visible project.
  scope: z.enum(['project', 'standalone']).optional(),
  projectId: ProjectIdSchema,
  projectName: NonEmptyStringSchema,
  teamId: TeamIdSchema,
  teamName: NonEmptyStringSchema,
  defaultThreadId: ThreadIdSchema,
  unreadCount: z.number().int().nonnegative(),
  // When the channel's default thread last received a message; null when it has
  // none. Populated on every channel-record emission (list, single read, and
  // post-mutation responses) so a cached list patched from a mutation response
  // never loses a row's recency.
  lastMessageAt: TimestampSchema.nullable(),
  // sp-channels: channel lifecycle fields
  topic: z.string().nullish(),
  description: z.string().nullish(),
  archivedAt: TimestampSchema.nullish(),
  memberRole: z.enum(['owner', 'admin', 'member', 'viewer']).nullish(),
  // Whether the caller has muted notifications for this channel (per-member).
  muted: z.boolean().optional(),
  // The list read fills this viewer-relative projection. Other ChannelRecord
  // producers omit it and clients refresh their channel-list entry after a
  // mutation rather than treating a generic record as an authority.
  personalAssistantPresences: PersonalAssistantPresenceParticipantSchema.array().optional(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
})
export type ChannelRecord = z.infer<typeof ChannelRecordSchema>

// One row in the direct-message unread inbox. It deliberately carries only
// the information needed to choose and open a conversation; the full message
// remains behind the normal thread reader and its disclosure checks.
export const UnreadDirectMessagePreviewSchema = z.object({
  content: z.string(),
  createdAt: TimestampSchema,
  deleted: z.literal(true).optional(),
  restricted: z.literal(true).optional(),
})
export type UnreadDirectMessagePreview = z.infer<typeof UnreadDirectMessagePreviewSchema>

export const UnreadDirectMessageRecordSchema = z.object({
  channelId: ChannelIdSchema,
  channelLabel: NonEmptyStringSchema,
  latestMessage: UnreadDirectMessagePreviewSchema,
  unreadCount: z.number().int().positive(),
})
export type UnreadDirectMessageRecord = z.infer<typeof UnreadDirectMessageRecordSchema>

export const UnreadDirectMessagesResponseSchema = z.object({
  items: z.array(UnreadDirectMessageRecordSchema),
})
export type UnreadDirectMessagesResponse = z.infer<typeof UnreadDirectMessagesResponseSchema>

// A deliberately small palette keeps agent portraits recognisable at a glance
// without turning their backgrounds into a second identity-setting surface.
export const AGENT_AVATAR_BACKGROUND_COLORS = [
  '#F8D7DA',
  '#FCE1C3',
  '#F9EDB7',
  '#D9F0D3',
  '#CDEDE7',
  '#D5E8FA',
  '#E1D8FA',
  '#F3D7EB',
] as const

export const AgentAvatarBackgroundColorSchema = z.enum(
  AGENT_AVATAR_BACKGROUND_COLORS,
)
export type AgentAvatarBackgroundColor = z.infer<
  typeof AgentAvatarBackgroundColorSchema
>

/**
 * Whether the recorded steward is still an entitled member of the agent's
 * organization, re-derived on every read rather than implied by the stored
 * pointer. `unknown` is honest rather than optimistic: it means no local
 * membership row answered, which phase 1 cannot distinguish from "removed
 * upstream" without the org-wide roster read.
 */
export const AgentOwnerStateSchema = z.enum(['active', 'deactivated', 'unknown'])
export type AgentOwnerState = z.infer<typeof AgentOwnerStateSchema>

export const AgentVisibilitySchema = z.enum(['workspace', 'private'])
export type AgentVisibility = z.infer<typeof AgentVisibilitySchema>

/**
 * The display projection for an agent's steward. It exists because there is no
 * member-readable endpoint mapping a local user id to a name — `GET /api/users`
 * is owner-only and the UOA roster is keyed by subject and scoped to one team —
 * so without this an owner cell could render an id and nothing else.
 *
 * Deliberately carries no `uoaSub`: an agent is visible across teams through any
 * public channel, so inlining a UOA subject would be a cross-team identity
 * disclosure decided before the org-wide directory entitlement has been.
 */
export const AgentOwnerSchema = z.object({
  userId: z.string().uuid(),
  displayName: z.string().optional(),
  avatarAttachmentId: z.string().uuid().nullish(),
  ownerState: AgentOwnerStateSchema,
})
export type AgentOwner = z.infer<typeof AgentOwnerSchema>

export const AgentRecordSchema = z.object({
  id: AgentIdSchema,
  name: NonEmptyStringSchema,
  role: NonEmptyStringSchema,
  status: AgentStatusSchema,
  /** Stewardship pointer. Null = unowned, a real category rather than an error. */
  ownerUserId: z.string().uuid().nullish(),
  /** Resolved steward for display; null whenever `ownerUserId` is null. */
  owner: AgentOwnerSchema.nullish(),
  agentKind: z.enum(['shared', 'personal_assistant']).optional(),
  systemManaged: z.boolean().optional(),
  visibility: AgentVisibilitySchema,
  /** Owner-only DM provisioned together with a private agent. */
  homeChannelId: ChannelIdSchema.optional(),
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
  effort: AgentEffortSchema.optional(),
  // Explicit per-run caps. Absent = every dimension governed by the deployment
  // backstop; `effort` carries no spend meaning (see
  // docs/plans/2026-08-05-run-budgets-context-and-research-routing.md §1).
  runLimits: AgentRunLimitsSchema.optional(),
  toolPolicy: z.record(z.string(), z.boolean()).optional(),
  avatarAttachmentId: z.string().uuid().nullish(),
  avatarBackgroundColor: AgentAvatarBackgroundColorSchema.optional(),
  routingProfileId: z.string().uuid().optional(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
  channelIds: z.array(ChannelIdSchema),
})
export type AgentRecord = z.infer<typeof AgentRecordSchema>

export const AgentTriggerStatusSchema = z.enum([
  'active',
  'paused',
  'error',
  // Non-runnable, but repairable by an authorized person re-proving identity
  // rather than by editing the trigger — the surface offers a different
  // action for it, which is why it is a state and not a flavour of `error`.
  'needs_reauthorization',
])
export type AgentTriggerStatus = z.infer<typeof AgentTriggerStatusSchema>

export const AgentTriggerRecordSchema = z.object({
  id: z.string().uuid(),
  agentId: AgentIdSchema.optional(),
  workflowInstallationId: z.string().uuid().optional(),
  type: AgentTriggerTypeSchema,
  status: AgentTriggerStatusSchema,
  enabled: z.boolean(),
  name: z.string().optional(),
  description: z.string().optional(),
  config: z.record(z.unknown()),
  // Why a non-runnable schedule stopped: a stable code the surface turns into
  // copy, plus the sentence the fire path composed. Without these the page can
  // show that a trigger failed but never what to do about it.
  healthReason: z.string().optional(),
  healthDetail: z.string().optional(),
  webhookApiKey: z.string().optional(),
  targetChannelId: ChannelIdSchema.optional(),
  targetThreadId: ThreadIdSchema.optional(),
  lastFiredAt: TimestampSchema.optional(),
  nextRunAt: TimestampSchema.optional(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
})
export type AgentTriggerRecord = z.infer<typeof AgentTriggerRecordSchema>

export const CreateAgentTriggerBodySchema = z.object({
  type: AgentTriggerTypeSchema,
  name: z.string().min(1).optional(),
  description: z.string().min(1).optional(),
  enabled: z.boolean().optional(),
  config: z.record(z.unknown()).optional(),
  nextRunAt: TimestampSchema.optional(),
  targetChannelId: ChannelIdSchema.optional(),
  targetThreadId: ThreadIdSchema.optional(),
})
export type CreateAgentTriggerBody = z.infer<typeof CreateAgentTriggerBodySchema>
