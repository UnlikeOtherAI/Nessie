import type {
  AgentRecord,
  ChannelRecord,
  MailboxConnectionRecord,
  MailboxConnectionScope,
  MailboxTransportSecurity,
  MeResponse,
} from '@nessie/schemas'

export type {
  AgentOwner,
  AgentRecord,
  ChannelRecord,
  PersonalAssistantPresenceParticipant,
  ProjectRecord,
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
  /** UOA holds this team's name, so it cannot be renamed in Nessie. */
  externallyManaged?: boolean
  id: string
  memberCount: number
  name: string
  projectId: string
  projectIds?: string[]
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
  // A project tool can be granted to a shared agent, but it runs only for a
  // person-started run in a project channel where that agent is bound.
  projectDelegatedOnly?: boolean
  personalAssistantOnly?: boolean
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
  /** Null unless the connection predates the project id being dropped. */
  projectId: string | null
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
  /** Null for a session a person resumed from the conversation. */
  runId: string | null
  status: 'allocating' | 'active' | 'releasing' | 'released' | 'failed' | 'unknown'
  startedAt: string
  endedAt: string | null
  controlledByUserId: string | null
}

export type CloudBrowserSessionDetail = CloudBrowserSessionSummary & {
  viewerMode: 'controller' | 'observer'
  controlLeaseActive: boolean
  /** Only the agent owner's exact private home can relay human input. */
  canControl: boolean
  /** Whether the session has a shared durable browser context. */
  shared: boolean
  /** The window the session is running in, already defaulted. */
  viewport: { width: number; height: number }
  /** When the idle window closes; the countdown reads this, not a local timer. */
  expiresAt: string
  /** Minted per read, never persisted: whoever holds it can drive the browser. */
  /** Always null: live frames are mediated by Nessie's screenshot endpoint. */
  liveViewUrl: null
  /** Owner-only one-time private access, while the task grant remains active. */
  privateAccess: { grantId: string; expiresAt: string } | null
  tabs: Array<{ id: string; title: string; url: string }>
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
  loginStatus: 'unsigned' | 'personal' | 'legacy_team_human'
  logins: AgentBrowserLoginRecord[]
}

/** A tab the agent's browser was last seen with; see the contract for the shape. */
export type AgentBrowserTabRecord = {
  id: string
  position: number
  url: string
  title: string
  capturedAt: string | null
  screenshotDataUrl: string | null
}

export type AgentBrowserTabsResponse = {
  hasBrowser: boolean
  quarantined: boolean
  tabs: AgentBrowserTabRecord[]
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
