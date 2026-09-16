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
  // How many messages in this room the viewer has not read, and when its
  // default thread last received one (`null` when it has none).
  //
  // Both are **participation** metadata derived from message history, and both
  // are therefore OPTIONAL rather than required: an organisation admin reading
  // a room they are not a member of receives the full management record with
  // these two fields ABSENT, because management is not participation
  // (`docs/standards/team-model.md`) and they have not read a room they cannot
  // open. Absent is the only honest answer — `0` and `null` would report "no
  // unread, never used" about a room that is busy, which is worse than silence.
  //
  // Every producer that HAS the history still sets them on every emission
  // (list, single read and post-mutation responses), so a cached list patched
  // from a mutation response never loses a row's recency. A client treats
  // `undefined` as "not applicable to me" and renders no badge and no
  // timestamp, never as zero.
  unreadCount: z.number().int().nonnegative().optional(),
  lastMessageAt: TimestampSchema.nullable().optional(),
  // sp-channels: channel lifecycle fields
  topic: z.string().nullish(),
  description: z.string().nullish(),
  archivedAt: TimestampSchema.nullish(),
  memberRole: z.enum(['owner', 'admin', 'member', 'viewer']).nullish(),
  // Whether the caller has muted notifications for this channel (per-member).
  muted: z.boolean().optional(),
  // Server-computed: may the viewer change this channel right now — rename,
  // archive, add or remove members (`canModifyChannel` — any member of the
  // channel, or an organisation owner/admin; never on a system channel; a DM
  // keeps its own participant rule)? Required, not optional, so a client can never
  // fall back to showing the control when a producer forgot to set it — see
  // `docs/standards/disclosure-boundaries.md` on `ChannelMember` writes.
  viewerCanManage: z.boolean(),
  // Server-computed: may the viewer add or remove an AGENT in this channel
  // right now? Deliberately separate from `viewerCanManage`, because the two
  // authorities genuinely differ — adding a person is any member of the
  // channel, while `POST/DELETE /api/agents/:agentId/bindings` require an
  // organisation OWNER or ADMIN who can see the channel (member or admin on a
  // standard non-system non-DM channel), and never on a system channel. The
  // client drew the agent "Add" control unconditionally while the server
  // refused every non-owner, which is the control-that-403s Rule zero names.
  //
  // It mirrors the routes' pre-policy gate exactly: able to see the channel,
  // not a system channel, organisation owner or admin. Those routes ALSO run
  // `checkPolicy('agent','bind')`, which an organisation can retune per scope;
  // a tightened policy is a deliberate narrowing and surfaces as the refusal
  // it is, rather than by silently hiding a control from the people the
  // default rules allow. Required, not optional, for the same reason as
  // `viewerCanManage`.
  viewerCanManageAgents: z.boolean(),
  // Viewer-relative: is the caller an explicit member of this channel?
  // Required so the client can suppress the composer for non-members (public
  // unjoined channels, protected channels, and admin management views).
  viewerIsMember: z.boolean(),
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
  // Optional on the wire so an older API build that omits it still parses.
  description: z.string().nullable().optional(),
  organizationId: OrganizationIdSchema,
  // Optional on the wire so an older API build that omits it still parses.
  // Present for projects read through routes that know the viewer.
  visibility: z.enum(['public', 'protected']).optional(),
  memberCount: z.number().int().nonnegative(),
  teamCount: z.number().int().nonnegative().optional(),
  channelCount: z.number().int().nonnegative().optional(),
  createdAt: TimestampSchema,
})
export type ProjectRecord = z.infer<typeof ProjectRecordSchema>

/**
 * A person in a project, as somebody outside it may see them: who they are,
 * and nothing about what they do there.
 */
export const ProjectDirectoryMemberSchema = z.object({
  userId: UserIdSchema,
  displayName: z.string(),
  avatarUrl: z.string().nullable(),
  avatarAttachmentId: z.string().uuid().nullable(),
})
export type ProjectDirectoryMember = z.infer<typeof ProjectDirectoryMemberSchema>

/**
 * One row of `GET /api/projects/directory` — every project in the organisation,
 * shaped by role (`docs/standards/team-model.md` → "What a person outside a
 * project may see").
 *
 * - `limited`: somebody outside the project. Its name, description and members
 *   and **nothing else** — no counts, avatar, boards, tasks, fields, sources,
 *   iterations, channels, settings or watchers. `.strict()` so a field added to
 *   the reader cannot reach an outsider without this schema changing too.
 * - `full`: a member of the project, or an organisation owner or admin, who may
 *   open it and gets the ordinary project record alongside.
 */
export const ProjectDirectoryEntrySchema = z.discriminatedUnion('access', [
  z.object({
    access: z.literal('limited'),
    id: ProjectIdSchema,
    name: NonEmptyStringSchema,
    description: z.string().nullable(),
    visibility: z.enum(['public', 'protected']),
    members: z.array(ProjectDirectoryMemberSchema),
  }).strict(),
  z.object({
    access: z.literal('full'),
    id: ProjectIdSchema,
    name: NonEmptyStringSchema,
    description: z.string().nullable(),
    visibility: z.enum(['public', 'protected']),
    members: z.array(ProjectDirectoryMemberSchema),
    project: ProjectRecordSchema,
    viewerIsMember: z.boolean(),
  }).strict(),
])
export type ProjectDirectoryEntry = z.infer<typeof ProjectDirectoryEntrySchema>

/**
 * One row of a channel directory or single-channel read for a non-member.
 * Matches the project-directory pattern: a non-member of a protected standard
 * channel sees name, description, visibility and members and nothing else.
 * A member (or an admin who can manage the channel) receives the full
 * ChannelRecord instead.
 */
export const ChannelDirectoryEntrySchema = z.discriminatedUnion('access', [
  z.object({
    access: z.literal('limited'),
    id: ChannelIdSchema,
    label: NonEmptyStringSchema,
    description: z.string().nullable(),
    visibility: z.enum(['public', 'protected']),
    members: z.array(ProjectDirectoryMemberSchema),
    projectName: NonEmptyStringSchema,
    teamName: NonEmptyStringSchema,
  }).strict(),
  z.object({
    access: z.literal('full'),
    channel: ChannelRecordSchema,
    viewerIsMember: z.boolean(),
  }).strict(),
])
export type ChannelDirectoryEntry = z.infer<typeof ChannelDirectoryEntrySchema>

export const TeamCallProviderSchema = z.enum([
  'google_meet',
  'jitsi',
  'microsoft_teams',
])

export const TeamRecordSchema = z.object({
  id: TeamIdSchema,
  name: NonEmptyStringSchema,
  projectId: ProjectIdSchema,
  projectIds: z.array(ProjectIdSchema).optional(),
  // Which provider a call in this team is minted with. Whether that provider is
  // *configured* on this deployment is answered by the API alone, so it is not
  // part of the record.
  callProvider: TeamCallProviderSchema,
  memberCount: z.number().int().nonnegative().optional(),
  // Whether the person asking is a member of this team — the placement
  // `createProjectForUser` requires of anybody but an organisation owner or
  // admin. Present when the reader was asked on a viewer's behalf.
  viewerIsMember: z.boolean().optional(),
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
 * guarantee that a steward still appears in the people directory — `GET
 * /api/users` omits deactivated people from a member's view and the UOA roster
 * is keyed by subject — so without this an owner cell could render an id and
 * nothing else.
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
  /** Server-decided browser capability; never inferred from a connection. */
  browserEnabled: z.boolean().optional(),
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
