import type { AgentRunLimits, AgentStatusResponse, MeResponse } from '@nessie/schemas'

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
  projectId: string
  projectName: string
  slug?: string | null
  systemChannelType?: 'personal_assistant' | string
  teamId: string
  teamName: string
  type: 'dm' | 'standard'
  dmUserId?: string | null
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
}

export type ProjectRecord = {
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
  createdAt: string
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
  channelId: string
  endedAt: string | null
  id: string
  participants: CallParticipantRecord[]
  roomId: string
  startedAt: string
  startedById: string
  status: 'active' | 'ended'
}

export type AgentRecord = {
  avatarAttachmentId?: string | null
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
  ownerUserId?: string | null
  role: string
  runLimits?: AgentRunLimits | null
  surfacePolicy?: 'shared' | 'dm_only'
  systemManaged?: boolean
  status: AgentStatusResponse['status']
  systemPrompt?: string
  toolPolicy?: Record<string, boolean>
  updatedAt: string
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
  gravatarUrl?: string | null
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
  gravatarUrl?: string | null
}

export type ThreadMessageRecord = {
  agentId?: string | null
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

export type ToolDescriptor = {
  builtin?: boolean
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

export type AgentTriggerRecord = {
  id: string
  agentId?: string
  workflowInstallationId?: string
  type: 'manual' | 'scheduled' | 'webhook' | 'event' | 'interval'
  status: 'active' | 'paused' | 'error'
  enabled: boolean
  name?: string
  description?: string
  config: Record<string, unknown>
  webhookApiKey?: string
  targetChannelId?: string
  targetThreadId?: string
  lastFiredAt?: string
  nextRunAt?: string
  createdAt: string
  updatedAt: string
}

export type WorkflowRunStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'

export type WorkflowStepRunStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'skipped'
  | 'blocked'

export type WorkflowTemplateRecord = {
  id: string
  organizationId: string
  name: string
  description?: string | null
  version: number
  graph: {
    steps: Array<{
      id: string
      input?: Record<string, unknown>
      title?: string
      type: string
    }>
  }
  triggers: unknown
  variableSchema: unknown
  bindingSchema: unknown
  requiredEnvironmentTemplateIds: string[]
  createdByActorType: string
  createdByActorId: string
  createdAt: string
  updatedAt: string
}

export type WorkflowInstallationRecord = {
  id: string
  workflowTemplateId: string
  workflowTemplateVersion: number
  organizationId: string
  channelId?: string | null
  projectId?: string | null
  teamId?: string | null
  status: 'active' | 'paused' | 'draft' | 'disabled'
  active: boolean
  resolvedBindings: Record<string, unknown>
  config: Record<string, unknown>
  createdByActorType: string
  createdByActorId: string
  createdAt: string
  updatedAt: string
}

export type WorkflowRunRecord = {
  id: string
  installationId: string
  organizationId: string
  triggerId?: string | null
  retriedFromWorkflowRunId?: string | null
  status: WorkflowRunStatus
  input: unknown
  output: unknown
  summary?: string | null
  errorMessage?: string | null
  startedByActorType: string
  startedByActorId: string
  startedAt?: string | null
  finishedAt?: string | null
  createdAt: string
  updatedAt: string
}

export type WorkflowStepRunRecord = {
  id: string
  workflowRunId: string
  stepKey: string
  stepType: string
  title: string
  sequence: number
  status: WorkflowStepRunStatus
  input: unknown
  output: unknown
  errorMessage?: string | null
  assignedAgentId?: string | null
  agentRunId?: string | null
  taskId?: string | null
  environmentInstanceId?: string | null
  startedAt?: string | null
  finishedAt?: string | null
  createdAt: string
  updatedAt: string
}

export type WorkflowRunDetail = {
  run: WorkflowRunRecord
  steps: WorkflowStepRunRecord[]
}

// §5 stepSamples: provenance + redacted per-step output from the last
// successful designer test run, served by the owner-gated samples route.
export type WorkflowStepSamplesRecord = {
  templateVersion: number
  workflowInstallationId: string
  workflowRunId: string
  capturedAt: string
  steps: Record<string, unknown>
}

export type AgentTriggerDeliveryRecord = {
  id: string
  triggerId: string
  dedupeKey?: string
  status: 'pending' | 'delivered' | 'failed' | 'skipped'
  source?: string
  payload: unknown
  errorMessage?: string
  runId?: string
  /** The run's terminal status, distinct from the delivery's dispatch status. */
  runStatus?: string
  deliveredAt?: string
  createdAt: string
}

export type SessionState =
  | {
      data: BootstrapModeResponse
      kind: 'bootstrap'
    }
  | {
      data: MeResponse
      kind: 'authenticated'
    }
