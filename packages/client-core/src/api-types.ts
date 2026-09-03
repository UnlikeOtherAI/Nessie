import type {
  AgentAvatarBackgroundColor,
  AgentRunLimits,
  AgentStatusResponse,
  AgentVisibility,
  MailboxConnectionRecord,
  MailboxConnectionScope,
  MailboxTransportSecurity,
  MeResponse,
} from '@nessie/schemas'

export type {
  UnreadDirectMessagePreview,
  UnreadDirectMessageRecord,
  UnreadDirectMessagesResponse,
} from '@nessie/schemas'

export type AuthProviderDescriptor = {
  autoRedirect: boolean
  enabled: boolean
  label: string
  providerId: string
  type: string
  url?: string
}

export type BootstrapModeResponse = {
  bootstrapMode: true
  bootstrapUrl: '/bootstrap'
}

export type ChannelMetadataRecord = {
  ownerUserId?: string
  systemChannelType?: 'personal_assistant' | string
  [key: string]: unknown
}

export type ChannelRecord = {
  createdAt: string
  defaultThreadId: string
  id: string
  label: string
  metadata?: ChannelMetadataRecord
  organizationId: string
  scope?: 'project' | 'standalone'
  projectId: string
  projectName: string
  slug?: string | null
  systemChannelType?: 'personal_assistant' | string
  teamId: string
  teamName: string
  type: 'dm' | 'standard'
  dmUserId?: string | null
  isGroupDm?: boolean
  unreadCount: number
  // When the channel's default thread last received a message; null when it has
  // none. Optional on the client so a UI stays functional against a server that
  // predates the field.
  lastMessageAt?: string | null
  updatedAt: string
  visibility: 'private' | 'protected' | 'public'
  // sp-channels: channel lifecycle fields
  topic?: string | null
  description?: string | null
  archivedAt?: string | null
  memberRole?: 'owner' | 'admin' | 'member' | 'viewer' | null
  // Whether the caller has muted notifications for this channel (per-member).
  muted?: boolean
  // A channel-scoped PA participant is deliberately not an AgentRecord: other
  // channel members never receive the singleton's private configuration.
  personalAssistantPresences?: PersonalAssistantPresenceParticipant[]
}

export type PersonalAssistantPresenceParticipant = {
  agentId: string
  avatarAttachmentId?: string | null
  displayName: string
  id: string
  isPersonalAssistant: true
  mentionName: string
  principalUserId: string
}

export type ProjectRecord = {
  avatarAttachmentId: string | null
  avatarEmoji: string | null
  channelCount?: number
  createdAt: string
  id: string
  memberCount: number
  name: string
  organizationId: string
  teamCount?: number
}

export type ProjectMemberRecord = {
  displayName: string
  email: string
  role: string
  userId: string
}

export type TeamRecord = {
  callProvider: 'google_meet' | 'jitsi' | 'microsoft_teams'
  callProviderAvailability: Record<'google_meet' | 'jitsi' | 'microsoft_teams', boolean>
  createdAt: string
  /** UOA holds this workspace's name, so it cannot be renamed in Nessie. */
  externallyManaged?: boolean
  id: string
  memberCount: number
  name: string
  projectId: string
}

export type CallParticipantRecord = {
  displayName: string
  joinedAt: string
  leftAt: string | null
  userId: string
}

export type CallRecord = {
  channelName: string
  channelId: string
  endedAt: string | null
  id: string
  invites: Array<{
    displayName: string
    respondedAt: string | null
    state: 'ringing' | 'accepted' | 'declined' | 'missed' | 'cancelled'
    userId: string
  }>
  meetingUri: string | null
  participants: CallParticipantRecord[]
  provider: 'google_meet' | 'jitsi' | 'microsoft_teams' | 'jitsi_embedded'
  revision: number
  ringExpiresAt: string | null
  roomId: string | null
  startedAt: string
  startedByDisplayName: string
  startedById: string
  status: 'ringing' | 'active' | 'ended' | 'missed' | 'declined' | 'cancelled'
}

/**
 * The resolved steward of an agent. `ownerState` is re-derived server-side on
 * every read rather than implied by the stored pointer, because a deactivated
 * membership row is retained deliberately and would otherwise still read as a
 * present colleague.
 */
export type AgentOwner = {
  avatarAttachmentId?: string | null
  displayName?: string
  ownerState: 'active' | 'deactivated' | 'unknown'
  userId: string
}

export type AgentRecord = {
  avatarAttachmentId?: string | null
  avatarBackgroundColor?: AgentAvatarBackgroundColor | null
  channelIds: string[]
  createdAt: string
  currentRunId?: string
  currentToolName?: string
  currentToolStartedAt?: string
  effort?: 'low' | 'medium' | 'high' | 'xhigh'
  id: string
  lastActivityAt: string
  model?: string
  name: string
  parentAgentId?: string | null
  provider?: string
  agentKind?: 'shared' | 'personal_assistant'
  delegationMode?: 'none' | 'act_as_requesting_user'
  owner?: AgentOwner | null
  ownerUserId?: string | null
  role: string
  runLimits?: AgentRunLimits | null
  surfacePolicy?: 'shared' | 'dm_only'
  systemManaged?: boolean
  /**
   * The global-agent blueprint this row instantiates, when it is one. Read-only
   * and server-written: it is how a client says "this is the Agent Designer"
   * structurally instead of matching a display name.
   */
  systemSlug?: string | null
  /**
   * Server-decided: addressing this system agent resolves to the caller's own
   * pre-provisioned home DM instead of binding it into a new conversation.
   * Present only when true — it is what puts the Personal Assistant and a
   * global agent in the "New message" address book without a client naming a
   * slug.
   */
  dmAddressable?: boolean
  todosEnabled: boolean
  /** Gemini Live voice for calls; null/absent = the deployment default. */
  voiceName?: string | null
  /** How the agent talks to people — prompt text, never a preset id. */
  speakingStyle?: string | null
  status: AgentStatusResponse['status']
  systemPrompt?: string
  toolPolicy?: Record<string, boolean>
  updatedAt: string
  /** Stored scope: private agents are visible only to their owner. */
  visibility: AgentVisibility
  /** Owner-only home DM created atomically for a private agent. */
  homeChannelId?: string
}

export type UserRecord = {
  channelIds: string[]
  createdAt: string
  displayName: string
  email: string
  id: string
  role: string
  // ISO timestamp when this org membership was deactivated, or null/absent when
  // the member is active.
  deactivatedAt?: string | null
  activeStatus?: UserActiveStatus | null
  avatarUrl?: string | null
  avatarAttachmentId?: string | null
  updatedAt: string
}

export type UserActiveStatus = {
  activeNow: boolean
  emoji: string | null
  id: string
  label: string
}

export type FavoriteTargetType = 'agent' | 'channel' | 'user'

export type FavoriteRecord = {
  createdAt: string
  targetId: string
  targetType: FavoriteTargetType
}

export type PresenceState = 'online' | 'away' | 'offline'

export type PresenceManualState = 'active' | 'away'

export type PresenceEntry = {
  userId: string
  state: PresenceState
  manualState: PresenceManualState | null
  statusId: string | null
  statusEmoji: string | null
  statusLabel: string | null
}

export type PresenceListResponse = {
  users: PresenceEntry[]
}

export type UserStatusScheduleKind = 'date_range' | 'weekly'

export type UserStatusRuleScope = 'fallback' | 'channel' | 'project'

export type UserStatusScheduleRecord = {
  createdAt: string
  dayOfWeek: number | null
  enabled: boolean
  endTime: string | null
  endsAt: string | null
  id: string
  kind: UserStatusScheduleKind
  label: string | null
  startTime: string | null
  startsAt: string | null
  statusId: string
  timezone: string
  updatedAt: string
}

export type UserStatusRuleRecord = {
  agentEnabled: boolean
  agentId: string | null
  channelId: string | null
  createdAt: string
  id: string
  instructions: string
  priority: number
  projectId: string | null
  scope: UserStatusRuleScope
  statusId: string
  updatedAt: string
}

export type UserStatusRecord = {
  activeNow: boolean
  agentEnabled: boolean
  agentInstructions: string | null
  createdAt: string
  emoji: string | null
  id: string
  isActive: boolean
  label: string
  organizationId: string
  rules: UserStatusRuleRecord[]
  schedules: UserStatusScheduleRecord[]
  updatedAt: string
  userId: string
}

export type MessageReaction = {
  id: string
  messageId: string
  agentId?: string | null
  onBehalfOfUserId?: string | null
  userId?: string | null
  emoji: string
  createdAt: string
}

// Embedded author identity for a user-authored message, so the feed can render
// the real sender's name + avatar. Absent for assistant/system messages.
export type MessageAuthor = {
  id: string
  displayName: string
  avatarUrl?: string | null
  avatarAttachmentId?: string | null
}

export type ThreadMessageRecord = {
  agentId?: string | null
  onBehalfOfUserId?: string | null
  // How many files this message carries, so the feed only fetches the
  // attachment list for messages that actually have one. Absent when the
  // producer could not determine it — fetch, rather than hide an attachment.
  attachmentCount?: number
  author?: MessageAuthor | null
  // Disclosure boundary. `restricted` — this reply used sources the reader
  // cannot reach, so `content` is empty and the row renders a placeholder.
  // `restrictedSources` — the reader CAN reach them, reads it normally, and is
  // the person who can share it. Mutually exclusive by construction.
  restricted?: true
  restrictedSources?: true
  /** Whether a standing rule may be offered; false for private material. */
  canShareStanding?: boolean
  content: string
  createdAt: string
  editedAt?: string | null
  deletedAt?: string | null
  id: string
  // Message-level reply threads (#233): set on replies; the metadata fields
  // are materialized on roots for collapsed-bar rendering.
  rootMessageId?: string | null
  replyCount?: number
  lastReplyAt?: string | null
  replyParticipantIds?: string[]
  metadata?: Record<string, unknown>
  reactions?: MessageReaction[]
  role: 'assistant' | 'system' | 'user'
  threadId: string
  userId?: string | null
}

// sp-messaging slice: full-text search result.
export type MessageSearchResult = {
  id: string
  threadId: string
  channelId: string
  channelLabel: string
  snippet: string
  createdAt: string
  authorName: string
  agentId?: string | null
  userId?: string | null
}

export type ThreadRecord = {
  channelId: string
  createdAt: string
  id: string
  title: string
  updatedAt?: string
}

export type PersonalAssistantInstanceRecord = {
  agentId: string
  channelId: string
  createdAt: string
  id: string
  status: 'active' | 'suspended' | 'archived'
  templateVersion: number
  updatedAt: string
}

export type PersonalAssistantConfigSummary = {
  agentId: string
  model?: string
  provider?: string
  systemPromptPreview?: string
  toolIds: string[]
  updatedAt: string
}

export type PersonalAssistantStateResponse = {
  agent: AgentRecord | null
  channel: ChannelRecord | null
  configSummary?: PersonalAssistantConfigSummary
  instance?: PersonalAssistantInstanceRecord | null
  thread?: ThreadRecord | null
}

export type PersonalAssistantBootstrapResponse = {
  agent: AgentRecord
  channel: ChannelRecord
  configSummary?: PersonalAssistantConfigSummary
  instance?: PersonalAssistantInstanceRecord | null
  thread: ThreadRecord
}

// A global agent's per-user home DM — the Agent Designer's chat. One call
// ensures and resolves it, so every client reaches that conversation the same
// way (see api/src/routes/global-agents.ts).
export type GlobalAgentHomeResponse = {
  agentId: string
  channel: ChannelRecord
  threadId: string
}

export type ToolDescriptor = {
  builtin?: boolean
  /**
   * Where the tool belongs in every surface that lists tools, declared by the
   * tool itself (`ToolCategoryId` in `@nessie/schemas`). Optional on the wire
   * only because an organization-local registry entry is not a builtin and has
   * none; every builtin carries one.
   */
  category?: string
  description: string
  enabled?: boolean
  handlerKind?: string
  id: string
  label: string
  // When true this builtin is OFF for every agent by default and needs an
  // explicit per-agent tool-policy allow to be exposed (mirrors the worker's
  // `requiresExplicitGrant` resolution — e.g. `deep_water_run_update`).
  requiresExplicitGrant?: boolean
  safe: boolean
}

export type {
  AgentTriggerActivityRecord,
  AgentTriggerDeliveryRecord,
  AgentTriggerRecord,
  WorkflowInstallationRecord,
  WorkflowRunDetail,
  WorkflowRunRecord,
  WorkflowRunStatus,
  WorkflowStepRunRecord,
  WorkflowStepRunStatus,
  WorkflowStepSamplesRecord,
  WorkflowTemplateRecord,
} from './api-workflow-types.js'

export type SessionState =
  | {
      data: BootstrapModeResponse
      kind: 'bootstrap'
    }
  | {
      data: MeResponse
      kind: 'authenticated'
    }

/** Cloud browsers (Browserbase). The API key never appears in a response. */
export type CloudBrowserScope = 'organization' | 'team' | 'user'

export type CloudBrowserConnectionRecord = {
  id: string
  scope: CloudBrowserScope
  projectId: string
  status: 'active' | 'needs_attention' | 'disabled'
  healthReason: string | null
  healthDetail: string | null
  createdAt: string
  liveSessions: number
  usedMinutes: number
  isMine: boolean
}

export type CloudBrowserSessionSummary = {
  id: string
  agentId: string
  agentName: string
  runId: string
  status: 'allocating' | 'active' | 'releasing' | 'released' | 'failed' | 'unknown'
  startedAt: string
  endedAt: string | null
  controlledByUserId: string | null
}

export type CloudBrowserSessionDetail = CloudBrowserSessionSummary & {
  /** Minted per read, never persisted: whoever holds it can drive the browser. */
  liveViewUrl: string | null
  tabs: Array<{ id: string; title: string; url: string; liveViewUrl: string }>
}

export type AgentBrowserLoginRecord = {
  id: string
  serviceHint: string
  createdAt: string
  signedInByUserId: string
  signedInByName: string | null
}

export type AgentBrowserRecord = {
  id: string
  connectionScope: CloudBrowserScope
  createdAt: string
  lastUsedAt: string | null
  inUse: boolean
  logins: AgentBrowserLoginRecord[]
}

export type MyBrowserLoginRecord = {
  id: string
  agentId: string
  agentName: string
  serviceHint: string
  createdAt: string
}

/**
 * Connected SMTP/IMAP mailboxes (agent email Model A). The record type is the
 * server's own contract, re-exported rather than restated so the two cannot
 * drift; there is no password field to strip because the shape has none.
 */
export type { MailboxConnectionRecord, MailboxConnectionScope, MailboxTransportSecurity }
