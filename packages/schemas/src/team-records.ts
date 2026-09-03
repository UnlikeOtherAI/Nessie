import { z } from 'zod'

import {
  AgentEffortSchema,
  AgentRunLimitsSchema,
  AgentStatusSchema,
  AgentTriggerTypeSchema,
  RunStatusSchema,
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
import { AgentSpeakingStyleSchema } from './agent-speech.js'
import { VoiceNameSchema } from './voice.js'

/**
 * Records the API returns for channels, agents, and triggers.
 *
 * They live here rather than in `api/src/contracts` because the services that
 * produce them (`@nessie/team-admin`) are shared with the worker: the
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

/**
 * A project and a team, produced by `@nessie/team-admin` for both
 * `POST /api/projects` / `POST /api/teams` and the Agent Designer's
 * `project_create` / `team_create` tools — so, like `ChannelRecord`, the shape
 * has to live where both processes can see it.
 */
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

export const TeamCallProviderSchema = z.enum([
  'google_meet',
  'jitsi',
  'microsoft_teams',
])

export const TeamRecordSchema = z.object({
  id: TeamIdSchema,
  name: NonEmptyStringSchema,
  projectId: ProjectIdSchema,
  // Which provider a call in this team is minted with. Whether that provider is
  // *configured* on this deployment is answered by the API alone, so it is not
  // part of the record.
  callProvider: TeamCallProviderSchema,
  memberCount: z.number().int().nonnegative().optional(),
  createdAt: TimestampSchema,
})
export type TeamRecord = z.infer<typeof TeamRecordSchema>

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

export const AgentVisibilitySchema = z.enum(['team', 'private'])
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
  /**
   * The global-agent blueprint this row instantiates, when it is one.
   *
   * Read-only and server-written — no create or update body accepts it. It is
   * here so a client can say "this is the Agent Designer" structurally instead
   * of matching a display name, which is what the sidebar's identity and its
   * "Continue in chat" doorway need.
   */
  systemSlug: z.string().nullish(),
  /**
   * Server-decided: this system agent is reached through the caller's own
   * pre-provisioned home DM, so addressing it opens that conversation instead
   * of binding it into a new one. Present only when true. It is what puts the
   * Personal Assistant and a global agent such as the Agent Designer in the
   * "New message" address book without any client naming a slug.
   */
  dmAddressable: z.boolean().optional(),
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
  todosEnabled: z.boolean(),
  /**
   * The Gemini Live voice this agent speaks in on a call. Absent = the
   * deployment default; the value is one of `GEMINI_LIVE_VOICES`.
   */
  voiceName: VoiceNameSchema.nullish(),
  /**
   * How this agent talks to people, in the person's own words. Reaches both the
   * typed system prompt and the voice call's system instruction.
   */
  speakingStyle: AgentSpeakingStyleSchema.nullish(),
  toolPolicy: z.record(z.string(), z.boolean()).optional(),
  avatarAttachmentId: z.string().uuid().nullish(),
  avatarBackgroundColor: AgentAvatarBackgroundColorSchema.optional(),
  // No `routingProfileId`: `mapAgentRecord` has never emitted the column, no
  // client reads it, and no write path sets it. It was the read-side half of
  // the same lie as the create body — see `CreateAgentBodySchema`.
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

/**
 * What a trigger is doing *right now*, kept apart from the trigger record
 * itself: one is configuration a person edits, the other is run state that
 * changes under them, and folding the second into the first would make every
 * trigger read pay for a run aggregate.
 *
 * `running` is a list rather than a flag, and that is the whole answer to
 * "what if two are executing at once". A trigger fires by writing an
 * `AgentTriggerDelivery`, and `Run.triggerDeliveryId` is unique — so one
 * delivery carries at most one run, two concurrent executions are two entries
 * with two delivery ids, and nothing has to be inferred from timestamps. A
 * surface renders the count it is given; it never decides whether "running"
 * means one thing or two.
 */
export const AgentTriggerRunSchema = z.object({
  // Plain uuids, like the trigger record's own `id` beside it: this is a
  // read-only projection, not an identity the type system routes on.
  runId: z.string().uuid(),
  // Null only for a run predating delivery correlation; the run is still real.
  deliveryId: z.string().uuid().nullable(),
  startedAt: TimestampSchema.nullable(),
  status: RunStatusSchema,
})
export type AgentTriggerRun = z.infer<typeof AgentTriggerRunSchema>

export const AgentTriggerActivityRecordSchema = z.object({
  triggerId: z.string().uuid(),
  running: AgentTriggerRunSchema.array(),
  /**
   * How this trigger's most recent *finished* run ended — what turns a row
   * green once its spinner stops. Deliberately the run's outcome and not the
   * delivery's status: a delivery is `delivered` the moment the run is
   * enqueued, which says the trigger fired, not that the work succeeded.
   */
  lastOutcome: z.enum(['completed', 'failed', 'cancelled']).nullable(),
  lastFinishedAt: TimestampSchema.nullable(),
})
export type AgentTriggerActivityRecord = z.infer<typeof AgentTriggerActivityRecordSchema>
