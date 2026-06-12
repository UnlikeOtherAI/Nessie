import {
  AgentIdSchema,
  AgentStatusSchema,
  AgentTriggerTypeSchema,
  AuthProviderResponseTypeSchema,
  ChannelIdSchema,
  CHAT_MESSAGE_MAX_CHARS,
  MessageRoleSchema,
  OrganizationIdSchema,
  PersonalAssistantConfigSummarySchema,
  ProjectIdSchema,
  RunIdSchema,
  TaskIdSchema,
  TaskStatusSchema,
  TeamIdSchema,
  ThreadIdSchema,
  UserIdSchema,
} from '@nessie/schemas'
import { z } from 'zod'

const TimestampSchema = z.string().min(1)
const NonEmptyStringSchema = z.string().min(1)

export const AuthProviderDescriptorSchema = z.object({
  providerId: NonEmptyStringSchema,
  type: AuthProviderResponseTypeSchema,
  label: NonEmptyStringSchema,
  enabled: z.boolean(),
  autoRedirect: z.boolean(),
})
export type AuthProviderDescriptor = z.infer<typeof AuthProviderDescriptorSchema>

export const AuthProviderAuthorizeQuerySchema = z.object({
  codeChallenge: NonEmptyStringSchema,
  redirectUri: z.string().url(),
  state: NonEmptyStringSchema,
})
export type AuthProviderAuthorizeQuery = z.infer<typeof AuthProviderAuthorizeQuerySchema>

export const BootstrapModeResponseSchema = z.object({
  bootstrapMode: z.literal(true),
  bootstrapUrl: z.literal('/bootstrap'),
})

export const BootstrapRequestSchema = z.object({
  bootstrapToken: z.string().uuid(),
  email: z.string().email(),
  displayName: NonEmptyStringSchema,
  password: z.string().min(8),
})

export const LoginRequestSchema = z.object({
  code: z.string().min(1).optional(),
  codeVerifier: z.string().min(1).optional(),
  email: z.string().email().optional(),
  password: z.string().min(1).optional(),
  providerId: NonEmptyStringSchema.optional(),
  redirectUri: z.string().url().optional(),
})

export const ChannelRecordSchema = z.object({
  id: ChannelIdSchema,
  label: NonEmptyStringSchema,
  type: z.enum(['standard', 'dm']),
  systemChannelType: z.enum(['personal_assistant']).optional(),
  visibility: z.enum(['public', 'protected', 'private']),
  organizationId: OrganizationIdSchema,
  projectId: ProjectIdSchema,
  projectName: NonEmptyStringSchema,
  teamId: TeamIdSchema,
  teamName: NonEmptyStringSchema,
  defaultThreadId: ThreadIdSchema,
  unreadCount: z.number().int().nonnegative(),
  // sp-channels: channel lifecycle fields
  topic: z.string().nullish(),
  description: z.string().nullish(),
  archivedAt: TimestampSchema.nullish(),
  memberRole: z.enum(['owner', 'admin', 'member', 'viewer']).nullish(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
})
export type ChannelRecord = z.infer<typeof ChannelRecordSchema>

// sp-channels: body for PATCH /api/channels/:channelId
export const UpdateChannelBodySchema = z
  .object({
    label: NonEmptyStringSchema.optional(),
    topic: z.string().max(500).nullable().optional(),
    description: z.string().max(2000).nullable().optional(),
  })
  .refine(
    (body) =>
      body.label !== undefined
      || body.topic !== undefined
      || body.description !== undefined,
    { message: 'At least one of label, topic, or description is required' },
  )
export type UpdateChannelBody = z.infer<typeof UpdateChannelBodySchema>

export const ProjectRecordSchema = z.object({
  id: ProjectIdSchema,
  name: NonEmptyStringSchema,
  organizationId: OrganizationIdSchema,
  memberCount: z.number().int().nonnegative(),
  teamCount: z.number().int().nonnegative().optional(),
  channelCount: z.number().int().nonnegative().optional(),
  createdAt: TimestampSchema,
})
export type ProjectRecord = z.infer<typeof ProjectRecordSchema>

export const ProjectMemberRecordSchema = z.object({
  userId: UserIdSchema,
  displayName: z.string(),
  email: z.string(),
  role: z.string(),
})
export type ProjectMemberRecord = z.infer<typeof ProjectMemberRecordSchema>

export const CallParticipantRecordSchema = z.object({
  userId: UserIdSchema,
  displayName: z.string(),
  joinedAt: TimestampSchema,
  leftAt: TimestampSchema.nullable(),
})

export const CallRecordSchema = z.object({
  id: z.string().uuid(),
  channelId: ChannelIdSchema,
  roomId: z.string(),
  status: z.enum(['active', 'ended']),
  startedById: UserIdSchema,
  startedAt: TimestampSchema,
  endedAt: TimestampSchema.nullable(),
  participants: z.array(CallParticipantRecordSchema),
})
export type CallRecord = z.infer<typeof CallRecordSchema>

export const EmptyBodySchema = z.object({})

export const CreateChannelBodySchema = z.object({
  label: NonEmptyStringSchema,
  teamId: TeamIdSchema.optional(),
  visibility: z.enum(['public', 'protected', 'private']).optional(),
})

export const UpdateProjectBodySchema = z.object({
  name: NonEmptyStringSchema,
})

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

export const CreateAgentBindingBodySchema = z.object({
  channelId: ChannelIdSchema,
})

export type AgentTriggerType = z.infer<typeof AgentTriggerTypeSchema>

export const AgentTriggerStatusSchema = z.enum(['active', 'paused', 'error'])
export type AgentTriggerStatus = z.infer<typeof AgentTriggerStatusSchema>

export const AgentTriggerDeliveryStatusSchema = z.enum([
  'pending',
  'delivered',
  'failed',
  'skipped',
])
export type AgentTriggerDeliveryStatus = z.infer<typeof AgentTriggerDeliveryStatusSchema>

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

export const CreateWorkflowTriggerBodySchema = z.object({
  type: AgentTriggerTypeSchema,
  name: z.string().min(1).optional(),
  description: z.string().min(1).optional(),
  enabled: z.boolean().optional(),
  config: z.record(z.unknown()).optional(),
  nextRunAt: TimestampSchema.optional(),
})

export const UpdateAgentTriggerBodySchema = z.object({
  name: z.string().min(1).nullable().optional(),
  description: z.string().min(1).nullable().optional(),
  enabled: z.boolean().optional(),
  status: AgentTriggerStatusSchema.optional(),
  config: z.record(z.unknown()).optional(),
  nextRunAt: TimestampSchema.nullable().optional(),
  targetChannelId: ChannelIdSchema.nullable().optional(),
  targetThreadId: ThreadIdSchema.nullable().optional(),
})

export const AgentTriggerDeliveryRecordSchema = z.object({
  id: z.string().uuid(),
  triggerId: z.string().uuid(),
  dedupeKey: z.string().optional(),
  status: AgentTriggerDeliveryStatusSchema,
  source: z.string().optional(),
  payload: z.unknown(),
  errorMessage: z.string().optional(),
  runId: RunIdSchema.optional(),
  deliveredAt: TimestampSchema.optional(),
  createdAt: TimestampSchema,
})
export type AgentTriggerDeliveryRecord = z.infer<typeof AgentTriggerDeliveryRecordSchema>

export const FireAgentTriggerBodySchema = z.object({
  dedupeKey: z.string().min(1).optional(),
  source: z.string().min(1).optional(),
  prompt: z.string().min(1).optional(),
  payload: z.unknown().optional(),
})

export const AddChannelMemberBodySchema = z.object({
  userId: UserIdSchema,
})

export const MessageReactionRecordSchema = z.object({
  id: z.string().uuid(),
  messageId: z.string().uuid(),
  agentId: AgentIdSchema.nullish(),
  userId: z.string().uuid().nullish(),
  emoji: z.string(),
  createdAt: TimestampSchema,
})
export type MessageReactionRecord = z.infer<typeof MessageReactionRecordSchema>

// Embedded author identity for a user-authored message, so the feed can render
// the real sender's name + avatar without a separate lookup. Absent for
// assistant/system messages (resolved via agentMap / a literal label instead).
export const MessageAuthorSchema = z.object({
  id: z.string().uuid(),
  displayName: z.string(),
  avatarUrl: z.string().nullish(),
  avatarAttachmentId: z.string().uuid().nullish(),
  gravatarUrl: z.string().nullish(),
})
export type MessageAuthor = z.infer<typeof MessageAuthorSchema>

export const ThreadMessageRecordSchema = z.object({
  id: z.string().uuid(),
  threadId: ThreadIdSchema,
  agentId: AgentIdSchema.nullish(),
  userId: z.string().uuid().nullish(),
  author: MessageAuthorSchema.nullish(),
  role: MessageRoleSchema,
  content: z.string(),
  createdAt: TimestampSchema,
  editedAt: TimestampSchema.nullish(),
  deletedAt: TimestampSchema.nullish(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  reactions: MessageReactionRecordSchema.array().optional(),
})
export type ThreadMessageRecord = z.infer<typeof ThreadMessageRecordSchema>

export const ThreadRecordSchema = z.object({
  id: ThreadIdSchema,
  channelId: ChannelIdSchema,
  title: z.string(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema.optional(),
})
export type ThreadRecord = z.infer<typeof ThreadRecordSchema>

// ─── File uploads / attachments (Slack-parity files slice) ──────────────────
export const AttachmentRecordSchema = z.object({
  id: z.string().uuid(),
  organizationId: OrganizationIdSchema,
  uploaderId: z.string().uuid().optional(),
  messageId: z.string().uuid().optional(),
  kind: NonEmptyStringSchema,
  mime: NonEmptyStringSchema,
  filename: NonEmptyStringSchema,
  sizeBytes: z.number().int().nonnegative(),
  width: z.number().int().nonnegative().optional(),
  height: z.number().int().nonnegative().optional(),
  createdAt: TimestampSchema,
})
export type AttachmentRecord = z.infer<typeof AttachmentRecordSchema>

export const CreateThreadMessageBodySchema = z.object({
  content: z.string().min(1).max(CHAT_MESSAGE_MAX_CHARS),
  // Attachments are uploaded first via POST /api/uploads; the returned ids are
  // linked to the message after it is created.
  attachmentIds: z.array(z.string().uuid()).optional(),
})

// ─── sp-messaging slice: edit, delete, search ──────────────────────────────
export const UpdateThreadMessageBodySchema = z.object({
  content: z.string().min(1).max(CHAT_MESSAGE_MAX_CHARS),
})
export type UpdateThreadMessageBody = z.infer<typeof UpdateThreadMessageBodySchema>

export const ListThreadMessagesQuerySchema = z.object({
  before: z.string().min(1).optional(),
  after: z.string().min(1).optional(),
  limit: z.coerce.number().int().positive().max(200).optional(),
  senderId: z.string().uuid().optional(),
})
export type ListThreadMessagesQuery = z.infer<typeof ListThreadMessagesQuerySchema>

export const MessageSearchResultSchema = z.object({
  id: z.string().uuid(),
  threadId: ThreadIdSchema,
  channelId: ChannelIdSchema,
  channelLabel: z.string(),
  snippet: z.string(),
  createdAt: TimestampSchema,
  authorName: z.string(),
  agentId: AgentIdSchema.nullish(),
  userId: z.string().uuid().nullish(),
})
export type MessageSearchResult = z.infer<typeof MessageSearchResultSchema>

export const MessageSearchQuerySchema = z.object({
  query: z.string().min(1),
  channelId: ChannelIdSchema.optional(),
  senderId: z.string().uuid().optional(),
  before: z.string().min(1).optional(),
  after: z.string().min(1).optional(),
  limit: z.coerce.number().int().positive().max(100).optional(),
})
export type MessageSearchQuery = z.infer<typeof MessageSearchQuerySchema>

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

export const ToolDescriptorSchema = z.object({
  id: NonEmptyStringSchema,
  label: NonEmptyStringSchema,
  description: NonEmptyStringSchema,
  safe: z.boolean(),
  builtin: z.boolean().optional(),
  enabled: z.boolean().optional(),
  handlerKind: z.string().optional(),
})
export type ToolDescriptor = z.infer<typeof ToolDescriptorSchema>

export const ToolRegistryEntrySchema = z.object({
  id: z.string().uuid(),
  organizationId: OrganizationIdSchema.nullish(),
  toolId: NonEmptyStringSchema,
  label: NonEmptyStringSchema,
  description: NonEmptyStringSchema,
  safe: z.boolean(),
  builtin: z.boolean(),
  enabled: z.boolean(),
  handlerKind: NonEmptyStringSchema,
  metadata: z.record(z.unknown()).default({}),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
})
export type ToolRegistryEntry = z.infer<typeof ToolRegistryEntrySchema>

export const CreateToolRegistryEntryBodySchema = z.object({
  toolId: NonEmptyStringSchema,
  label: NonEmptyStringSchema,
  description: NonEmptyStringSchema,
  safe: z.boolean().optional(),
  builtin: z.boolean().optional(),
  enabled: z.boolean().optional(),
  handlerKind: NonEmptyStringSchema.optional(),
  metadata: z.record(z.unknown()).optional(),
})

export const TemporaryContextSessionSchema = z.object({
  id: z.string().uuid(),
  organizationId: OrganizationIdSchema,
  agentId: AgentIdSchema.nullish(),
  runId: RunIdSchema.nullish(),
  threadId: ThreadIdSchema.nullish(),
  title: z.string().nullish(),
  toolIds: z.array(NonEmptyStringSchema),
  createdByActorType: NonEmptyStringSchema,
  createdByActorId: NonEmptyStringSchema,
  droppedAt: TimestampSchema.nullish(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
})
export type TemporaryContextSession = z.infer<typeof TemporaryContextSessionSchema>

export const CreateTemporaryContextSessionBodySchema = z.object({
  agentId: AgentIdSchema.optional(),
  runId: RunIdSchema.optional(),
  threadId: ThreadIdSchema.optional(),
  title: z.string().optional(),
  toolIds: z.array(NonEmptyStringSchema).min(1),
})

export const PlanStatusSchema = z.enum([
  'draft',
  'active',
  'waiting',
  'completed',
  'failed',
  'cancelled',
])
export type PlanStatus = z.infer<typeof PlanStatusSchema>

export const PlanStepStatusSchema = z.enum([
  'pending',
  'running',
  'completed',
  'failed',
  'skipped',
  'blocked',
])
export type PlanStepStatus = z.infer<typeof PlanStepStatusSchema>

export const PlanRecordSchema = z.object({
  id: z.string().uuid(),
  organizationId: OrganizationIdSchema,
  projectId: z.string().uuid().nullish(),
  teamId: z.string().uuid().nullish(),
  channelId: ChannelIdSchema.nullish(),
  runId: RunIdSchema.nullish(),
  agentId: AgentIdSchema.nullish(),
  goal: NonEmptyStringSchema,
  summary: z.string().nullish(),
  status: PlanStatusSchema,
  createdByActorType: NonEmptyStringSchema,
  createdByActorId: NonEmptyStringSchema,
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
})
export type PlanRecord = z.infer<typeof PlanRecordSchema>

export const PlanStepRecordSchema = z.object({
  id: z.string().uuid(),
  planId: z.string().uuid(),
  assignedAgentId: AgentIdSchema.nullish(),
  type: NonEmptyStringSchema,
  title: NonEmptyStringSchema,
  sequence: z.number().int().nonnegative(),
  status: PlanStepStatusSchema,
  payload: z.record(z.unknown()).default({}),
  artifacts: z.record(z.unknown()).default({}),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
})
export type PlanStepRecord = z.infer<typeof PlanStepRecordSchema>

export const CreatePlanBodySchema = z.object({
  agentId: AgentIdSchema.optional(),
  channelId: ChannelIdSchema.optional(),
  goal: NonEmptyStringSchema,
  runId: RunIdSchema.optional(),
  summary: z.string().optional(),
})

export const CreatePlanStepBodySchema = z.object({
  assignedAgentId: AgentIdSchema.optional(),
  artifacts: z.record(z.unknown()).optional(),
  payload: z.record(z.unknown()).optional(),
  sequence: z.number().int().nonnegative().optional(),
  title: NonEmptyStringSchema,
  type: NonEmptyStringSchema,
})

export const MailboxMessageStatusSchema = z.enum([
  'queued',
  'processing',
  'delivered',
  'dead_letter',
])
export type MailboxMessageStatus = z.infer<typeof MailboxMessageStatusSchema>

export const MailboxMessageRecordSchema = z.object({
  id: z.string().uuid(),
  organizationId: OrganizationIdSchema,
  planId: z.string().uuid().nullish(),
  planStepId: z.string().uuid().nullish(),
  workflowRunId: z.string().uuid().nullish(),
  workflowStepRunId: z.string().uuid().nullish(),
  fromAgentId: AgentIdSchema.nullish(),
  toAgentId: AgentIdSchema.nullish(),
  channelId: ChannelIdSchema.nullish(),
  threadId: ThreadIdSchema.nullish(),
  subject: z.string().nullish(),
  body: z.string(),
  correlationId: z.string().nullish(),
  status: MailboxMessageStatusSchema,
  attempts: z.number().int().nonnegative(),
  visibleAt: TimestampSchema,
  claimedAt: TimestampSchema.nullish(),
  deliveredAt: TimestampSchema.nullish(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
})
export type MailboxMessageRecord = z.infer<typeof MailboxMessageRecordSchema>

export const CreateMailboxMessageBodySchema = z.object({
  body: NonEmptyStringSchema,
  channelId: ChannelIdSchema.optional(),
  correlationId: NonEmptyStringSchema.optional(),
  fromAgentId: AgentIdSchema.optional(),
  planId: z.string().uuid().optional(),
  planStepId: z.string().uuid().optional(),
  workflowRunId: z.string().uuid().optional(),
  workflowStepRunId: z.string().uuid().optional(),
  subject: z.string().optional(),
  threadId: ThreadIdSchema.optional(),
  toAgentId: AgentIdSchema.optional(),
})

export const WorkflowInstallationStatusSchema = z.enum([
  'draft',
  'active',
  'paused',
  'disabled',
])
export type WorkflowInstallationStatus = z.infer<typeof WorkflowInstallationStatusSchema>

export const WorkflowRunStatusSchema = z.enum([
  'pending',
  'running',
  'completed',
  'failed',
  'cancelled',
])
export type WorkflowRunStatus = z.infer<typeof WorkflowRunStatusSchema>

export const WorkflowStepRunStatusSchema = z.enum([
  'pending',
  'running',
  'completed',
  'failed',
  'skipped',
  'blocked',
])
export type WorkflowStepRunStatus = z.infer<typeof WorkflowStepRunStatusSchema>

export const WorkflowStepDefinitionSchema = z.object({
  id: NonEmptyStringSchema,
  input: z.record(z.unknown()).optional(),
  title: z.string().optional(),
  type: NonEmptyStringSchema,
})
export type WorkflowStepDefinition = z.infer<typeof WorkflowStepDefinitionSchema>

export const WorkflowGraphSchema = z.object({
  steps: z.array(WorkflowStepDefinitionSchema).min(1),
})
export type WorkflowGraph = z.infer<typeof WorkflowGraphSchema>

export const WorkflowTemplateRecordSchema = z.object({
  id: z.string().uuid(),
  organizationId: OrganizationIdSchema,
  name: NonEmptyStringSchema,
  description: z.string().nullish(),
  version: z.number().int().positive(),
  graph: WorkflowGraphSchema,
  triggers: z.unknown(),
  variableSchema: z.unknown(),
  bindingSchema: z.unknown(),
  requiredEnvironmentTemplateIds: z.array(z.string().uuid()),
  createdByActorType: NonEmptyStringSchema,
  createdByActorId: NonEmptyStringSchema,
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
})
export type WorkflowTemplateRecord = z.infer<typeof WorkflowTemplateRecordSchema>

export const CreateWorkflowTemplateBodySchema = z.object({
  name: NonEmptyStringSchema,
  description: z.string().optional(),
  graph: WorkflowGraphSchema,
  triggers: z.unknown().optional(),
  variableSchema: z.unknown().optional(),
  bindingSchema: z.unknown().optional(),
  requiredEnvironmentTemplateIds: z.array(z.string().uuid()).optional(),
})

export const UpdateWorkflowTemplateBodySchema = CreateWorkflowTemplateBodySchema

export const WorkflowInstallationRecordSchema = z.object({
  id: z.string().uuid(),
  workflowTemplateId: z.string().uuid(),
  workflowTemplateVersion: z.number().int().positive(),
  organizationId: OrganizationIdSchema,
  projectId: z.string().uuid().nullish(),
  teamId: z.string().uuid().nullish(),
  channelId: ChannelIdSchema.nullish(),
  status: WorkflowInstallationStatusSchema,
  active: z.boolean(),
  resolvedBindings: z.record(z.unknown()).default({}),
  config: z.record(z.unknown()).default({}),
  createdByActorType: NonEmptyStringSchema,
  createdByActorId: NonEmptyStringSchema,
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
})
export type WorkflowInstallationRecord = z.infer<typeof WorkflowInstallationRecordSchema>

export const InstallWorkflowTemplateBodySchema = z.object({
  channelId: ChannelIdSchema.optional(),
  active: z.boolean().optional(),
  status: WorkflowInstallationStatusSchema.optional(),
  resolvedBindings: z.record(z.unknown()).optional(),
  config: z.record(z.unknown()).optional(),
})

export const WorkflowRunRecordSchema = z.object({
  id: z.string().uuid(),
  installationId: z.string().uuid(),
  organizationId: OrganizationIdSchema,
  triggerId: z.string().uuid().nullish(),
  triggerDeliveryId: z.string().uuid().nullish(),
  parentRunId: RunIdSchema.nullish(),
  retriedFromWorkflowRunId: z.string().uuid().nullish(),
  planId: z.string().uuid().nullish(),
  planStepId: z.string().uuid().nullish(),
  status: WorkflowRunStatusSchema,
  input: z.unknown(),
  output: z.unknown(),
  summary: z.string().nullish(),
  errorMessage: z.string().nullish(),
  startedByActorType: NonEmptyStringSchema,
  startedByActorId: NonEmptyStringSchema,
  startedAt: TimestampSchema.nullish(),
  finishedAt: TimestampSchema.nullish(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
})
export type WorkflowRunRecord = z.infer<typeof WorkflowRunRecordSchema>

export const WorkflowStepRunRecordSchema = z.object({
  id: z.string().uuid(),
  workflowRunId: z.string().uuid(),
  stepKey: NonEmptyStringSchema,
  stepType: NonEmptyStringSchema,
  title: NonEmptyStringSchema,
  sequence: z.number().int().nonnegative(),
  status: WorkflowStepRunStatusSchema,
  input: z.unknown(),
  output: z.unknown(),
  errorMessage: z.string().nullish(),
  assignedAgentId: AgentIdSchema.nullish(),
  agentRunId: RunIdSchema.nullish(),
  taskId: z.string().uuid().nullish(),
  environmentInstanceId: z.string().uuid().nullish(),
  startedAt: TimestampSchema.nullish(),
  finishedAt: TimestampSchema.nullish(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
})
export type WorkflowStepRunRecord = z.infer<typeof WorkflowStepRunRecordSchema>

export const WorkflowStateEntryRecordSchema = z.object({
  id: z.string().uuid(),
  organizationId: OrganizationIdSchema,
  workflowInstallationId: z.string().uuid(),
  workflowRunId: z.string().uuid().nullish(),
  workflowStepRunId: z.string().uuid().nullish(),
  key: NonEmptyStringSchema,
  value: z.unknown(),
  valueHash: NonEmptyStringSchema,
  version: z.number().int().positive(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
})
export type WorkflowStateEntryRecord = z.infer<typeof WorkflowStateEntryRecordSchema>

export const CreateWorkflowRunBodySchema = z.object({
  input: z.record(z.unknown()).optional(),
  triggerId: z.string().uuid().optional(),
  triggerDeliveryId: z.string().uuid().optional(),
  parentRunId: RunIdSchema.optional(),
  planId: z.string().uuid().optional(),
  planStepId: z.string().uuid().optional(),
})

export const CancelWorkflowRunBodySchema = z.object({
  reason: z.string().min(1).optional(),
})

export const RetryWorkflowRunBodySchema = z.object({
  reason: z.string().min(1).optional(),
})

export const SkipWorkflowStepRunBodySchema = z.object({
  reason: z.string().min(1).optional(),
})

export const BlockWorkflowStepRunBodySchema = z.object({
  reason: z.string().min(1).optional(),
})

export const UnblockWorkflowStepRunBodySchema = z.object({
  reason: z.string().min(1).optional(),
})

export const ExecutionProviderSchema = z.enum(['docker', 'gcloud'])
export type ExecutionProvider = z.infer<typeof ExecutionProviderSchema>

export const ExecutionModeSchema = z.enum(['container', 'vm', 'function'])
export type ExecutionMode = z.infer<typeof ExecutionModeSchema>

export const ExecutionEnvironmentInstanceStatusSchema = z.enum([
  'pending',
  'provisioning',
  'ready',
  'failed',
  'terminated',
])
export type ExecutionEnvironmentInstanceStatus = z.infer<typeof ExecutionEnvironmentInstanceStatusSchema>

export const ExecutionRunnerStatusSchema = z.enum(['active', 'draining', 'offline'])
export type ExecutionRunnerStatus = z.infer<typeof ExecutionRunnerStatusSchema>

export const ExecutionLeaseStatusSchema = z.enum([
  'issued',
  'acknowledged',
  'completed',
  'revoked',
  'expired',
])
export type ExecutionLeaseStatus = z.infer<typeof ExecutionLeaseStatusSchema>

export const ExecutionEnvironmentTemplateRecordSchema = z.object({
  id: z.string().uuid(),
  organizationId: OrganizationIdSchema,
  projectId: z.string().uuid().nullish(),
  teamId: z.string().uuid().nullish(),
  channelId: ChannelIdSchema.nullish(),
  name: NonEmptyStringSchema,
  description: z.string().nullish(),
  provider: ExecutionProviderSchema,
  mode: ExecutionModeSchema,
  image: z.string().nullish(),
  launchConfig: z.record(z.unknown()).default({}),
  pricingConfig: z.record(z.unknown()).default({}),
  enabled: z.boolean(),
  createdByActorType: NonEmptyStringSchema,
  createdByActorId: NonEmptyStringSchema,
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
})
export type ExecutionEnvironmentTemplateRecord = z.infer<
  typeof ExecutionEnvironmentTemplateRecordSchema
>

export const CreateExecutionEnvironmentTemplateBodySchema = z.object({
  name: NonEmptyStringSchema,
  description: z.string().optional(),
  provider: ExecutionProviderSchema,
  mode: ExecutionModeSchema,
  image: z.string().optional(),
  launchConfig: z.record(z.unknown()).optional(),
  pricingConfig: z.record(z.unknown()).optional(),
  enabled: z.boolean().optional(),
  channelId: ChannelIdSchema.optional(),
})

export const ExecutionEnvironmentInstanceRecordSchema = z.object({
  id: z.string().uuid(),
  templateId: z.string().uuid(),
  organizationId: OrganizationIdSchema,
  projectId: z.string().uuid().nullish(),
  teamId: z.string().uuid().nullish(),
  channelId: ChannelIdSchema.nullish(),
  workflowRunId: z.string().uuid().nullish(),
  workflowStepRunId: z.string().uuid().nullish(),
  runId: RunIdSchema.nullish(),
  agentId: AgentIdSchema.nullish(),
  status: ExecutionEnvironmentInstanceStatusSchema,
  launchedByActorType: NonEmptyStringSchema,
  launchedByActorId: NonEmptyStringSchema,
  providerInstanceRef: z.string().nullish(),
  launchConfig: z.record(z.unknown()).default({}),
  metadata: z.record(z.unknown()).default({}),
  errorMessage: z.string().nullish(),
  startedAt: TimestampSchema.nullish(),
  readyAt: TimestampSchema.nullish(),
  terminatedAt: TimestampSchema.nullish(),
  lastHeartbeatAt: TimestampSchema.nullish(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
})
export type ExecutionEnvironmentInstanceRecord = z.infer<
  typeof ExecutionEnvironmentInstanceRecordSchema
>

export const LaunchExecutionEnvironmentBodySchema = z.object({
  templateId: z.string().uuid(),
  workflowRunId: z.string().uuid().optional(),
  workflowStepRunId: z.string().uuid().optional(),
  runId: RunIdSchema.optional(),
  agentId: AgentIdSchema.optional(),
  channelId: ChannelIdSchema.optional(),
  launchConfig: z.record(z.unknown()).optional(),
})

export const ExecutionRunnerRecordSchema = z.object({
  id: z.string().uuid(),
  organizationId: OrganizationIdSchema.nullish(),
  provider: ExecutionProviderSchema,
  label: NonEmptyStringSchema,
  capabilities: z.record(z.unknown()).default({}),
  status: ExecutionRunnerStatusSchema,
  heartbeatAt: TimestampSchema.nullish(),
  metadata: z.record(z.unknown()).default({}),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
})
export type ExecutionRunnerRecord = z.infer<typeof ExecutionRunnerRecordSchema>

export const ExecutionLeaseRecordSchema = z.object({
  id: z.string().uuid(),
  instanceId: z.string().uuid(),
  runnerId: z.string().uuid(),
  status: ExecutionLeaseStatusSchema,
  leaseToken: NonEmptyStringSchema,
  expiresAt: TimestampSchema,
  acknowledgedAt: TimestampSchema.nullish(),
  completedAt: TimestampSchema.nullish(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
})
export type ExecutionLeaseRecord = z.infer<typeof ExecutionLeaseRecordSchema>

export const ExecutionUsageLedgerRecordSchema = z.object({
  id: z.string().uuid(),
  instanceId: z.string().uuid(),
  templateId: z.string().uuid(),
  organizationId: OrganizationIdSchema,
  projectId: z.string().uuid().nullish(),
  teamId: z.string().uuid().nullish(),
  channelId: ChannelIdSchema.nullish(),
  workflowRunId: z.string().uuid().nullish(),
  workflowStepRunId: z.string().uuid().nullish(),
  runId: RunIdSchema.nullish(),
  agentId: AgentIdSchema.nullish(),
  actorType: NonEmptyStringSchema,
  actorId: NonEmptyStringSchema,
  meterType: NonEmptyStringSchema,
  quantity: z.number().nonnegative(),
  unitPrice: z.number().nonnegative().nullish(),
  costAmount: z.number().nonnegative().nullish(),
  currency: z.string().nullish(),
  metadata: z.record(z.unknown()).default({}),
  recordedAt: TimestampSchema,
})
export type ExecutionUsageLedgerRecord = z.infer<typeof ExecutionUsageLedgerRecordSchema>

export const ResourceLockTypeSchema = z.enum(['exclusive', 'shared'])
export type ResourceLockType = z.infer<typeof ResourceLockTypeSchema>

export const ResourceLockRecordSchema = z.object({
  id: z.string().uuid(),
  organizationId: OrganizationIdSchema,
  planId: z.string().uuid().nullish(),
  runId: RunIdSchema.nullish(),
  agentId: AgentIdSchema,
  resourcePath: NonEmptyStringSchema,
  lockType: ResourceLockTypeSchema,
  acquiredAt: TimestampSchema,
  expiresAt: TimestampSchema,
  releasedAt: TimestampSchema.nullish(),
})
export type ResourceLockRecord = z.infer<typeof ResourceLockRecordSchema>

export const AcquireResourceLockBodySchema = z.object({
  agentId: AgentIdSchema,
  expiresAt: TimestampSchema.optional(),
  lockType: ResourceLockTypeSchema.optional(),
  planId: z.string().uuid().optional(),
  resourcePath: NonEmptyStringSchema,
  runId: RunIdSchema.optional(),
})

export const PublishEventBodySchema = z.object({
  dedupeKey: z.string().min(1).optional(),
  eventType: NonEmptyStringSchema,
  payload: z.record(z.unknown()).default({}),
  source: z.string().min(1).optional(),
})

// ─── Inference control plane ──────────────────────────────────────────────

export const InferenceConnectorKindSchema = z.enum(['compiled', 'openai-compatible'])
export type InferenceConnectorKind = z.infer<typeof InferenceConnectorKindSchema>

export const InferenceLifecycleStatusSchema = z.enum(['draft', 'approved', 'deprecated'])
export type InferenceLifecycleStatus = z.infer<typeof InferenceLifecycleStatusSchema>

export const InferenceHealthStatusSchema = z.enum([
  'healthy',
  'degraded',
  'unreachable',
  'unknown',
])
export type InferenceHealthStatus = z.infer<typeof InferenceHealthStatusSchema>

export const InferenceCapabilitySourceSchema = z.enum(['static', 'live', 'manual'])
export type InferenceCapabilitySource = z.infer<typeof InferenceCapabilitySourceSchema>

export const InferenceExposureSchema = z.enum(['standard', 'admin-only'])
export type InferenceExposure = z.infer<typeof InferenceExposureSchema>

export const InferenceRoutingModeSchema = z.enum([
  'single',
  'fallback',
  'committee',
  'pipeline',
  'shadow',
])
export type InferenceRoutingMode = z.infer<typeof InferenceRoutingModeSchema>

export const InferenceStageRoleSchema = z.enum([
  'advisor',
  'executor',
  'synthesizer',
  'judge',
  'shadow',
])
export type InferenceStageRole = z.infer<typeof InferenceStageRoleSchema>

export const InferenceStreamPolicySchema = z.enum(['primary-only', 'buffered-judge'])
export type InferenceStreamPolicy = z.infer<typeof InferenceStreamPolicySchema>

export const InferenceEvalStatusSchema = z.enum([
  'queued',
  'running',
  'completed',
  'failed',
  'cancelled',
])
export type InferenceEvalStatus = z.infer<typeof InferenceEvalStatusSchema>

export const NormalizedFinishReasonSchema = z.enum([
  'stop',
  'length',
  'tool-call',
  'content-filter',
  'error',
  'other',
])
export type NormalizedFinishReason = z.infer<typeof NormalizedFinishReasonSchema>

export const ToolCallingModeSchema = z.enum(['native', 'prompt-translated', 'disabled'])
export type ToolCallingMode = z.infer<typeof ToolCallingModeSchema>

export const StructuredOutputModeSchema = z.enum([
  'native-json',
  'prompt-json',
  'text-only',
])
export type StructuredOutputMode = z.infer<typeof StructuredOutputModeSchema>

export const SystemPromptModeSchema = z.enum(['native', 'fold-into-user'])
export type SystemPromptMode = z.infer<typeof SystemPromptModeSchema>

export const ToolResultModeSchema = z.enum(['native-tool-message', 'context-block'])
export type ToolResultMode = z.infer<typeof ToolResultModeSchema>

export const ProviderHealthStatusSchema = z.enum([
  'healthy',
  'degraded',
  'unreachable',
  'unknown',
])
export type ProviderHealthStatus = z.infer<typeof ProviderHealthStatusSchema>

export const ProviderMessageContentPartSchema = z.union([
  z.object({
    type: z.literal('text'),
    text: z.string(),
  }),
  z.object({
    type: z.literal('image'),
    imageUrl: z.string().min(1),
  }),
])
export type ProviderMessageContentPart = z.infer<typeof ProviderMessageContentPartSchema>

const ProviderMessageContentSchema = z.union([
  z.string(),
  ProviderMessageContentPartSchema.array(),
])

export const ProviderToolCallSchema = z.object({
  toolCallId: z.string().min(1),
  toolName: NonEmptyStringSchema,
  arguments: z.record(z.unknown()),
  reason: z.string().optional(),
})
export type ProviderToolCall = z.infer<typeof ProviderToolCallSchema>

export const ProviderMessageSchema = z.discriminatedUnion('role', [
  z.object({
    role: z.literal('system'),
    content: ProviderMessageContentSchema,
  }),
  z.object({
    role: z.literal('user'),
    content: ProviderMessageContentSchema,
  }),
  z.object({
    role: z.literal('assistant'),
    content: ProviderMessageContentSchema.nullable(),
    toolCalls: ProviderToolCallSchema.array().optional(),
  }),
  z.object({
    role: z.literal('tool'),
    content: z.string(),
    toolCallId: z.string().min(1),
  }),
])
export type ProviderMessage = z.infer<typeof ProviderMessageSchema>

export const ToolSchemaDescriptorSchema = z.object({
  toolName: NonEmptyStringSchema,
  description: NonEmptyStringSchema,
  inputSchema: z.record(z.unknown()),
})
export type ToolSchemaDescriptor = z.infer<typeof ToolSchemaDescriptorSchema>

export const ToolCallIntentSchema = z.object({
  toolName: NonEmptyStringSchema,
  arguments: z.record(z.unknown()),
  reason: z.string().optional(),
})
export type ToolCallIntent = z.infer<typeof ToolCallIntentSchema>

export const StructuredOutputDescriptorSchema = z.object({
  name: NonEmptyStringSchema,
  jsonSchema: z.record(z.unknown()),
})
export type StructuredOutputDescriptor = z.infer<typeof StructuredOutputDescriptorSchema>

export const JsonObjectResponseFormatSchema = z.object({
  type: z.literal('json_object'),
})
export type JsonObjectResponseFormat = z.infer<
  typeof JsonObjectResponseFormatSchema
>

export const ToolChoiceSchema = z.union([
  z.enum(['auto', 'none', 'required']),
  z.object({
    type: z.literal('function'),
    function: z.object({
      name: NonEmptyStringSchema,
    }),
  }),
])
export type ToolChoice = z.infer<typeof ToolChoiceSchema>

export const ModelCapabilityUsageReportingSchema = z.object({
  inputTokens: z.boolean(),
  outputTokens: z.boolean(),
  cachedInputTokens: z.boolean(),
  cachedOutputTokens: z.boolean(),
  cacheReadTokens: z.boolean(),
  cacheWriteTokens: z.boolean(),
  providerReportedCost: z.boolean(),
})
export type ModelCapabilityUsageReporting = z.infer<
  typeof ModelCapabilityUsageReportingSchema
>

export const ModelCapabilitySnapshotSchema = z.object({
  provider: NonEmptyStringSchema,
  model: NonEmptyStringSchema,
  displayName: z.string().optional(),
  supportsModelDiscovery: z.boolean(),
  supportsChat: z.boolean(),
  supportsStreaming: z.boolean(),
  supportsEmbeddings: z.boolean(),
  supportsVision: z.boolean(),
  toolCallingMode: ToolCallingModeSchema,
  structuredOutputMode: StructuredOutputModeSchema,
  systemPromptMode: SystemPromptModeSchema,
  toolResultMode: ToolResultModeSchema,
  usageReporting: ModelCapabilityUsageReportingSchema,
  maxInputTokens: z.number().int().positive().optional(),
  maxOutputTokens: z.number().int().positive().optional(),
  source: InferenceCapabilitySourceSchema,
  discoveredAt: TimestampSchema,
  lastVerifiedAt: TimestampSchema.optional(),
})
export type ModelCapabilitySnapshot = z.infer<typeof ModelCapabilitySnapshotSchema>

export const CapabilityResolutionSourceSchema = z.enum([
  'override',
  'static',
  'live',
  'manual',
])
export type CapabilityResolutionSource = z.infer<typeof CapabilityResolutionSourceSchema>

export const CapabilityResolutionSchema = z.object({
  effectiveSnapshot: ModelCapabilitySnapshotSchema,
  effectiveSource: CapabilityResolutionSourceSchema,
  overrideActive: z.boolean(),
})
export type CapabilityResolution = z.infer<typeof CapabilityResolutionSchema>

export const InvocationUsageSchema = z.object({
  inputTokens: z.number().int().nonnegative().optional(),
  outputTokens: z.number().int().nonnegative().optional(),
  cachedInputTokens: z.number().int().nonnegative().optional(),
  cachedOutputTokens: z.number().int().nonnegative().optional(),
  cacheReadTokens: z.number().int().nonnegative().optional(),
  cacheWriteTokens: z.number().int().nonnegative().optional(),
  totalTokens: z.number().int().nonnegative().optional(),
})
export type InvocationUsage = z.infer<typeof InvocationUsageSchema>

export const InvocationRecordSchema = z.object({
  invocationId: z.string().uuid(),
  requestId: NonEmptyStringSchema,
  correlationId: NonEmptyStringSchema.optional(),
  provider: NonEmptyStringSchema,
  model: NonEmptyStringSchema,
  operationType: z.enum([
    'chat',
    'completion',
    'embedding',
    'translation',
    'reasoning',
    'tool-translation',
    'other',
  ]),
  usage: InvocationUsageSchema,
  providerReportedCost: z
    .object({
      amount: z.number().nonnegative(),
      currency: NonEmptyStringSchema,
    })
    .optional(),
  latencyMs: z.number().int().nonnegative(),
  finishReason: NormalizedFinishReasonSchema.optional(),
  metadata: z.record(z.unknown()).optional(),
})
export type InvocationRecord = z.infer<typeof InvocationRecordSchema>

export const ProviderInvocationRequestSchema = z.object({
  requestId: NonEmptyStringSchema,
  correlationId: NonEmptyStringSchema.optional(),
  model: NonEmptyStringSchema,
  messages: ProviderMessageSchema.array(),
  tools: ToolSchemaDescriptorSchema.array().optional(),
  toolChoice: ToolChoiceSchema.optional(),
  responseFormat: JsonObjectResponseFormatSchema.optional(),
  expectedStructuredOutput: StructuredOutputDescriptorSchema.optional(),
  maxOutputTokens: z.number().int().positive().optional(),
  temperature: z.number().optional(),
  metadata: z.record(z.unknown()).optional(),
})
export type ProviderInvocationRequest = z.infer<typeof ProviderInvocationRequestSchema>

export const ProviderInvocationResultSchema = z.object({
  outputText: z.string(),
  toolCalls: ProviderToolCallSchema.array().default([]),
  structuredOutput: z.unknown().optional(),
  finishReason: NormalizedFinishReasonSchema.optional(),
  invocation: InvocationRecordSchema,
})
export type ProviderInvocationResult = z.infer<typeof ProviderInvocationResultSchema>

export const ProviderStreamEventSchema = z.union([
  z.object({
    type: z.literal('output_text.delta'),
    text: z.string(),
  }),
  z.object({
    type: z.literal('tool_call.delta'),
    text: z.string(),
  }),
  z.object({
    type: z.literal('response.error'),
    message: z.string(),
    retryable: z.boolean(),
  }),
])
export type ProviderStreamEvent = z.infer<typeof ProviderStreamEventSchema>

export const MultiProviderResultSchema = z.object({
  requestId: NonEmptyStringSchema,
  correlationId: NonEmptyStringSchema.optional(),
  status: z.enum(['completed', 'failed']),
  finalAnswer: z.string().optional(),
  structuredOutput: z.unknown().optional(),
  answerOwner: z
    .object({
      stageId: NonEmptyStringSchema,
      stageRole: InferenceStageRoleSchema,
      provider: NonEmptyStringSchema,
      model: NonEmptyStringSchema,
      invocationId: z.string().uuid(),
    })
    .optional(),
  toolCalls: ProviderToolCallSchema.array().default([]),
  toolExecutionOwner: z
    .object({
      stageId: NonEmptyStringSchema,
      provider: NonEmptyStringSchema,
      model: NonEmptyStringSchema,
      invocationId: z.string().uuid(),
    })
    .nullable(),
  failure: z
    .object({
      code: z.string(),
      message: z.string(),
      stageId: z.string().min(1).optional(),
    })
    .optional(),
  invocations: InvocationRecordSchema.array(),
})
export type MultiProviderResult = z.infer<typeof MultiProviderResultSchema>

export const RouteStageSchema = z.object({
  id: NonEmptyStringSchema,
  role: InferenceStageRoleSchema,
  provider: NonEmptyStringSchema,
  model: NonEmptyStringSchema,
  toolCallingMode: ToolCallingModeSchema.optional(),
  inputFrom: z.array(NonEmptyStringSchema).optional(),
  userVisible: z.boolean().optional(),
  maxAttempts: z.number().int().positive().optional(),
})
export type RouteStage = z.infer<typeof RouteStageSchema>

export const RouteGraphSchema = z.object({
  stages: RouteStageSchema.array().min(1),
})
export type RouteGraph = z.infer<typeof RouteGraphSchema>

export const CandidateOutputSchema = z.object({
  stageId: NonEmptyStringSchema,
  stageRole: InferenceStageRoleSchema,
  outputText: z.string(),
  structuredOutput: z.unknown().optional(),
  toolCalls: ToolCallIntentSchema.array().optional(),
  invocationIds: z.array(z.string().uuid()),
  finishReason: NormalizedFinishReasonSchema.optional(),
  metadata: z.record(z.unknown()).optional(),
})
export type CandidateOutput = z.infer<typeof CandidateOutputSchema>

export const StageExecutionInputSchema = z.object({
  baseMessages: ProviderMessageSchema.array(),
  upstream: CandidateOutputSchema.array(),
})
export type StageExecutionInput = z.infer<typeof StageExecutionInputSchema>

export const EvalDatasetRefSchema = z.object({
  kind: z.enum(['file', 'dataset', 'query']),
  value: NonEmptyStringSchema,
})
export type DatasetRef = z.infer<typeof EvalDatasetRefSchema>

export const EvalSummarySchema = z.object({
  totalCases: z.number().int().nonnegative(),
  passedCases: z.number().int().nonnegative(),
  failedCases: z.number().int().nonnegative(),
  score: z.number().nonnegative(),
  blockingFailures: z.array(z.string()),
})
export type EvalSummary = z.infer<typeof EvalSummarySchema>

export const EvalCaseVerdictSchema = z.enum(['pass', 'fail', 'blocked', 'skipped'])
export type EvalCaseVerdict = z.infer<typeof EvalCaseVerdictSchema>

export const EvalCaseResultSchema = z.object({
  caseId: NonEmptyStringSchema,
  input: z.unknown(),
  expected: z.unknown().optional(),
  actual: z.unknown(),
  verdict: EvalCaseVerdictSchema,
  invocationIds: z.array(z.string().uuid()),
  metadata: z.record(z.unknown()).optional(),
})
export type EvalCaseResult = z.infer<typeof EvalCaseResultSchema>

export const InferenceProviderRecordSchema = z.object({
  id: z.string().uuid(),
  organizationId: OrganizationIdSchema,
  providerKey: NonEmptyStringSchema,
  connectorKind: InferenceConnectorKindSchema,
  displayName: NonEmptyStringSchema,
  enabled: z.boolean(),
  lifecycleStatus: InferenceLifecycleStatusSchema,
  baseUrl: z.string().min(1).optional(),
  supportsModelDiscovery: z.boolean(),
  activeCredentialBindingId: z.string().uuid().optional(),
  healthStatus: InferenceHealthStatusSchema,
  lastCheckedAt: TimestampSchema.optional(),
  createdByActorId: NonEmptyStringSchema,
  updatedByActorId: NonEmptyStringSchema,
  approvedByActorId: NonEmptyStringSchema.optional(),
  approvedAt: TimestampSchema.optional(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
})
export type InferenceProviderRecord = z.infer<typeof InferenceProviderRecordSchema>

export const CreateInferenceProviderBodySchema = z.object({
  providerKey: NonEmptyStringSchema,
  connectorKind: InferenceConnectorKindSchema,
  displayName: NonEmptyStringSchema,
  baseUrl: z.string().min(1).optional(),
  supportsModelDiscovery: z.boolean().optional(),
  enabled: z.boolean().optional(),
})
export type CreateInferenceProviderBody = z.infer<
  typeof CreateInferenceProviderBodySchema
>

export const UpdateInferenceProviderBodySchema = z.object({
  providerKey: NonEmptyStringSchema.optional(),
  connectorKind: InferenceConnectorKindSchema.optional(),
  displayName: NonEmptyStringSchema.optional(),
  baseUrl: z.string().min(1).nullable().optional(),
  supportsModelDiscovery: z.boolean().optional(),
  activeCredentialBindingId: z.string().uuid().nullable().optional(),
  enabled: z.boolean().optional(),
})
export type UpdateInferenceProviderBody = z.infer<
  typeof UpdateInferenceProviderBodySchema
>

export const SetInferenceProviderHealthBodySchema = z.object({
  healthStatus: InferenceHealthStatusSchema,
  lastCheckedAt: TimestampSchema.optional(),
})
export type SetInferenceProviderHealthBody = z.infer<
  typeof SetInferenceProviderHealthBodySchema
>

// Note: authSecretRef is intentionally omitted from the response record. It is
// accepted on create (CreateInferenceCredentialBindingBodySchema) and resolved
// server-side at inference time; clients never need it back, and returning it
// would needlessly disclose the secret reference.
export const InferenceCredentialBindingRecordSchema = z.object({
  id: z.string().uuid(),
  organizationId: OrganizationIdSchema,
  providerId: z.string().uuid(),
  label: NonEmptyStringSchema,
  createdByActorId: NonEmptyStringSchema,
  revokedAt: TimestampSchema.optional(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
})
export type InferenceCredentialBindingRecord = z.infer<
  typeof InferenceCredentialBindingRecordSchema
>

export const CreateInferenceCredentialBindingBodySchema = z.object({
  providerId: z.string().uuid(),
  label: NonEmptyStringSchema,
  authSecretRef: NonEmptyStringSchema,
})
export type CreateInferenceCredentialBindingBody = z.infer<
  typeof CreateInferenceCredentialBindingBodySchema
>

export const InferenceModelRecordSchema = z.object({
  id: z.string().uuid(),
  organizationId: OrganizationIdSchema,
  providerId: z.string().uuid(),
  model: NonEmptyStringSchema,
  displayName: z.string().optional(),
  enabled: z.boolean(),
  lifecycleStatus: InferenceLifecycleStatusSchema,
  capabilitySnapshot: ModelCapabilitySnapshotSchema,
  source: InferenceCapabilitySourceSchema,
  discoveredAt: TimestampSchema,
  lastVerifiedAt: TimestampSchema.optional(),
  createdByActorId: NonEmptyStringSchema,
  updatedByActorId: NonEmptyStringSchema,
  approvedByActorId: NonEmptyStringSchema.optional(),
  approvedAt: TimestampSchema.optional(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
})
export type InferenceModelRecord = z.infer<typeof InferenceModelRecordSchema>

export const CreateInferenceModelBodySchema = z.object({
  providerId: z.string().uuid(),
  model: NonEmptyStringSchema,
  displayName: z.string().min(1).optional(),
  enabled: z.boolean().optional(),
  capabilitySnapshot: ModelCapabilitySnapshotSchema,
  source: InferenceCapabilitySourceSchema.optional(),
  discoveredAt: TimestampSchema.optional(),
  lastVerifiedAt: TimestampSchema.optional(),
})
export type CreateInferenceModelBody = z.infer<typeof CreateInferenceModelBodySchema>

export const UpdateInferenceModelBodySchema = z.object({
  displayName: z.string().min(1).nullable().optional(),
  enabled: z.boolean().optional(),
  capabilitySnapshot: ModelCapabilitySnapshotSchema.optional(),
  source: InferenceCapabilitySourceSchema.optional(),
  discoveredAt: TimestampSchema.optional(),
  lastVerifiedAt: TimestampSchema.nullable().optional(),
})
export type UpdateInferenceModelBody = z.infer<typeof UpdateInferenceModelBodySchema>

export const InferenceCapabilityOverrideRecordSchema = z.object({
  id: z.string().uuid(),
  organizationId: OrganizationIdSchema,
  providerId: z.string().uuid(),
  model: NonEmptyStringSchema,
  lifecycleStatus: InferenceLifecycleStatusSchema,
  overrideSnapshot: ModelCapabilitySnapshotSchema,
  createdByActorId: NonEmptyStringSchema,
  updatedByActorId: NonEmptyStringSchema,
  createdAt: TimestampSchema,
  clearedAt: TimestampSchema.optional(),
  approvedByActorId: NonEmptyStringSchema.optional(),
  approvedAt: TimestampSchema.optional(),
  updatedAt: TimestampSchema,
})
export type InferenceCapabilityOverrideRecord = z.infer<
  typeof InferenceCapabilityOverrideRecordSchema
>

export const CreateInferenceCapabilityOverrideBodySchema = z.object({
  providerId: z.string().uuid(),
  model: NonEmptyStringSchema,
  overrideSnapshot: ModelCapabilitySnapshotSchema,
})
export type CreateInferenceCapabilityOverrideBody = z.infer<
  typeof CreateInferenceCapabilityOverrideBodySchema
>

export const UpdateInferenceCapabilityOverrideBodySchema = z.object({
  overrideSnapshot: ModelCapabilitySnapshotSchema.optional(),
  clearedAt: TimestampSchema.nullable().optional(),
})
export type UpdateInferenceCapabilityOverrideBody = z.infer<
  typeof UpdateInferenceCapabilityOverrideBodySchema
>

export const InferenceRoutingProfileRecordSchema = z.object({
  id: z.string().uuid(),
  organizationId: OrganizationIdSchema,
  label: NonEmptyStringSchema,
  enabled: z.boolean(),
  exposure: InferenceExposureSchema,
  lifecycleStatus: InferenceLifecycleStatusSchema,
  mode: InferenceRoutingModeSchema,
  streamPolicy: InferenceStreamPolicySchema,
  toolMediatorProfileId: z.string().uuid().optional(),
  routeGraph: RouteGraphSchema,
  createdByActorId: NonEmptyStringSchema,
  updatedByActorId: NonEmptyStringSchema,
  approvedByActorId: NonEmptyStringSchema.optional(),
  approvedAt: TimestampSchema.optional(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
})
export type InferenceRoutingProfileRecord = z.infer<
  typeof InferenceRoutingProfileRecordSchema
>

export const CreateInferenceRoutingProfileBodySchema = z.object({
  label: NonEmptyStringSchema,
  enabled: z.boolean().optional(),
  exposure: InferenceExposureSchema.optional(),
  mode: InferenceRoutingModeSchema,
  streamPolicy: InferenceStreamPolicySchema.optional(),
  toolMediatorProfileId: z.string().uuid().optional(),
  routeGraph: RouteGraphSchema,
})
export type CreateInferenceRoutingProfileBody = z.infer<
  typeof CreateInferenceRoutingProfileBodySchema
>

export const UpdateInferenceRoutingProfileBodySchema = z.object({
  label: NonEmptyStringSchema.optional(),
  enabled: z.boolean().optional(),
  exposure: InferenceExposureSchema.optional(),
  mode: InferenceRoutingModeSchema.optional(),
  streamPolicy: InferenceStreamPolicySchema.optional(),
  toolMediatorProfileId: z.string().uuid().nullable().optional(),
  routeGraph: RouteGraphSchema.optional(),
})
export type UpdateInferenceRoutingProfileBody = z.infer<
  typeof UpdateInferenceRoutingProfileBodySchema
>

export const ToolMediatorProfileRecordSchema = z.object({
  id: z.string().uuid(),
  organizationId: OrganizationIdSchema,
  label: NonEmptyStringSchema,
  enabled: z.boolean(),
  lifecycleStatus: InferenceLifecycleStatusSchema,
  translatorProvider: NonEmptyStringSchema,
  translatorModel: NonEmptyStringSchema,
  mediatorConfig: z.record(z.unknown()).default({}),
  createdByActorId: NonEmptyStringSchema,
  updatedByActorId: NonEmptyStringSchema,
  approvedByActorId: NonEmptyStringSchema.optional(),
  approvedAt: TimestampSchema.optional(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
})
export type ToolMediatorProfileRecord = z.infer<typeof ToolMediatorProfileRecordSchema>

export const CreateToolMediatorProfileBodySchema = z.object({
  label: NonEmptyStringSchema,
  enabled: z.boolean().optional(),
  translatorProvider: NonEmptyStringSchema,
  translatorModel: NonEmptyStringSchema,
  mediatorConfig: z.record(z.unknown()).optional(),
})
export type CreateToolMediatorProfileBody = z.infer<
  typeof CreateToolMediatorProfileBodySchema
>

export const UpdateToolMediatorProfileBodySchema = z.object({
  label: NonEmptyStringSchema.optional(),
  enabled: z.boolean().optional(),
  translatorProvider: NonEmptyStringSchema.optional(),
  translatorModel: NonEmptyStringSchema.optional(),
  mediatorConfig: z.record(z.unknown()).optional(),
})
export type UpdateToolMediatorProfileBody = z.infer<
  typeof UpdateToolMediatorProfileBodySchema
>

export const InferenceEvalSuiteRecordSchema = z.object({
  id: z.string().uuid(),
  organizationId: OrganizationIdSchema,
  label: NonEmptyStringSchema,
  exposure: InferenceExposureSchema,
  enabled: z.boolean(),
  datasetRef: EvalDatasetRefSchema,
  targetRoutingProfileId: z.string().uuid(),
  judgeRoutingProfileId: z.string().uuid().optional(),
  lifecycleStatus: InferenceLifecycleStatusSchema,
  createdByActorId: NonEmptyStringSchema,
  updatedByActorId: NonEmptyStringSchema,
  approvedByActorId: NonEmptyStringSchema.optional(),
  approvedAt: TimestampSchema.optional(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
})
export type InferenceEvalSuiteRecord = z.infer<typeof InferenceEvalSuiteRecordSchema>

export const CreateInferenceEvalSuiteBodySchema = z.object({
  label: NonEmptyStringSchema,
  exposure: InferenceExposureSchema.optional(),
  enabled: z.boolean().optional(),
  datasetRef: EvalDatasetRefSchema,
  targetRoutingProfileId: z.string().uuid(),
  judgeRoutingProfileId: z.string().uuid().optional(),
})
export type CreateInferenceEvalSuiteBody = z.infer<
  typeof CreateInferenceEvalSuiteBodySchema
>

export const UpdateInferenceEvalSuiteBodySchema = z.object({
  label: NonEmptyStringSchema.optional(),
  exposure: InferenceExposureSchema.optional(),
  enabled: z.boolean().optional(),
  datasetRef: EvalDatasetRefSchema.optional(),
  targetRoutingProfileId: z.string().uuid().optional(),
  judgeRoutingProfileId: z.string().uuid().nullable().optional(),
})
export type UpdateInferenceEvalSuiteBody = z.infer<
  typeof UpdateInferenceEvalSuiteBodySchema
>

export const InferenceEvalRunRecordSchema = z.object({
  id: z.string().uuid(),
  organizationId: OrganizationIdSchema,
  evalSuiteId: z.string().uuid(),
  startedByActorId: NonEmptyStringSchema,
  startedAt: TimestampSchema,
  finishedAt: TimestampSchema.optional(),
  status: InferenceEvalStatusSchema,
  summary: EvalSummarySchema,
  result: z.record(z.unknown()).default({}),
  caseResults: EvalCaseResultSchema.array(),
  targetProfileSnapshot: InferenceRoutingProfileRecordSchema,
  judgeProfileSnapshot: InferenceRoutingProfileRecordSchema.optional(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
})
export type InferenceEvalRunRecord = z.infer<typeof InferenceEvalRunRecordSchema>

export const CreateInferenceEvalRunBodySchema = z.object({
  evalSuiteId: z.string().uuid(),
})
export type CreateInferenceEvalRunBody = z.infer<typeof CreateInferenceEvalRunBodySchema>

export const UpdateInferenceEvalRunBodySchema = z.object({
  status: InferenceEvalStatusSchema.optional(),
  summary: EvalSummarySchema.optional(),
  result: z.record(z.unknown()).optional(),
  caseResults: EvalCaseResultSchema.array().optional(),
  targetProfileSnapshot: InferenceRoutingProfileRecordSchema.optional(),
  judgeProfileSnapshot: InferenceRoutingProfileRecordSchema.nullable().optional(),
  startedAt: TimestampSchema.optional(),
  finishedAt: TimestampSchema.nullable().optional(),
})
export type UpdateInferenceEvalRunBody = z.infer<typeof UpdateInferenceEvalRunBodySchema>

// ─── Designer chat ────────────────────────────────────────────────────────

export const DesignerChatMessageSchema = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.string(),
})

export const DesignerFormStateSchema = z.object({
  name: z.string(),
  role: z.string(),
  systemPrompt: z.string(),
  provider: z.string(),
  model: z.string(),
  tools: z.record(z.string(), z.boolean()),
})

export const DesignerChatBodySchema = z.object({
  messages: z.array(DesignerChatMessageSchema),
  formState: DesignerFormStateSchema,
})

// ─── Users ────────────────────────────────────────────────────────────────

export const UserActiveStatusSchema = z.object({
  id: z.string().uuid(),
  label: NonEmptyStringSchema,
  emoji: z.string().nullable(),
  activeNow: z.boolean(),
})
export type UserActiveStatus = z.infer<typeof UserActiveStatusSchema>

export const UserStatusScheduleKindSchema = z.enum(['date_range', 'weekly'])
export type UserStatusScheduleKind = z.infer<typeof UserStatusScheduleKindSchema>

export const UserStatusRuleScopeSchema = z.enum(['fallback', 'channel', 'project'])
export type UserStatusRuleScope = z.infer<typeof UserStatusRuleScopeSchema>
const StatusLabelSchema = z.string().trim().min(1).max(120)
const StatusInstructionsSchema = z.string().trim().min(1).max(8000)

export const UserStatusScheduleRecordSchema = z.object({
  id: z.string().uuid(),
  statusId: z.string().uuid(),
  kind: UserStatusScheduleKindSchema,
  label: z.string().nullable(),
  enabled: z.boolean(),
  startsAt: TimestampSchema.nullable(),
  endsAt: TimestampSchema.nullable(),
  dayOfWeek: z.number().int().min(0).max(6).nullable(),
  startTime: z.string().nullable(),
  endTime: z.string().nullable(),
  timezone: NonEmptyStringSchema,
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
})
export type UserStatusScheduleRecord = z.infer<
  typeof UserStatusScheduleRecordSchema
>

export const UserStatusRuleRecordSchema = z.object({
  id: z.string().uuid(),
  statusId: z.string().uuid(),
  scope: UserStatusRuleScopeSchema,
  channelId: ChannelIdSchema.nullable(),
  projectId: ProjectIdSchema.nullable(),
  agentId: AgentIdSchema.nullable(),
  agentEnabled: z.boolean(),
  instructions: NonEmptyStringSchema,
  priority: z.number().int(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
})
export type UserStatusRuleRecord = z.infer<typeof UserStatusRuleRecordSchema>

export const UserStatusRecordSchema = z.object({
  id: z.string().uuid(),
  organizationId: OrganizationIdSchema,
  userId: UserIdSchema,
  label: NonEmptyStringSchema,
  emoji: z.string().nullable(),
  isActive: z.boolean(),
  activeNow: z.boolean(),
  agentEnabled: z.boolean(),
  agentInstructions: z.string().nullable(),
  schedules: UserStatusScheduleRecordSchema.array(),
  rules: UserStatusRuleRecordSchema.array(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
})
export type UserStatusRecord = z.infer<typeof UserStatusRecordSchema>

export const CreateUserStatusBodySchema = z.object({
  label: StatusLabelSchema,
  emoji: z.string().max(16).nullable().optional(),
  agentEnabled: z.boolean().optional(),
  agentInstructions: z.string().max(8000).nullable().optional(),
})
export type CreateUserStatusBody = z.infer<typeof CreateUserStatusBodySchema>

export const UpdateUserStatusBodySchema = z.object({
  label: StatusLabelSchema.optional(),
  emoji: z.string().max(16).nullable().optional(),
  agentEnabled: z.boolean().optional(),
  agentInstructions: z.string().max(8000).nullable().optional(),
})
export type UpdateUserStatusBody = z.infer<typeof UpdateUserStatusBodySchema>

const TimeOfDaySchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/)

export const CreateUserStatusScheduleBodySchema = z
  .object({
    kind: UserStatusScheduleKindSchema,
    label: z.string().max(120).nullable().optional(),
    enabled: z.boolean().optional(),
    startsAt: z.string().datetime().nullable().optional(),
    endsAt: z.string().datetime().nullable().optional(),
    dayOfWeek: z.number().int().min(0).max(6).nullable().optional(),
    startTime: TimeOfDaySchema.nullable().optional(),
    endTime: TimeOfDaySchema.nullable().optional(),
    timezone: NonEmptyStringSchema.optional(),
  })
  .superRefine((body, context) => {
    if (body.kind === 'date_range' && (!body.startsAt || !body.endsAt)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Date range schedules require startsAt and endsAt',
      })
    }
    if (
      body.kind === 'weekly' &&
      (body.dayOfWeek === null ||
        body.dayOfWeek === undefined ||
        !body.startTime ||
        !body.endTime)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Weekly schedules require dayOfWeek, startTime, and endTime',
      })
    }
  })
export type CreateUserStatusScheduleBody = z.infer<
  typeof CreateUserStatusScheduleBodySchema
>

export const UpdateUserStatusScheduleBodySchema = z.object({
  label: z.string().max(120).nullable().optional(),
  enabled: z.boolean().optional(),
  startsAt: z.string().datetime().nullable().optional(),
  endsAt: z.string().datetime().nullable().optional(),
  dayOfWeek: z.number().int().min(0).max(6).nullable().optional(),
  startTime: TimeOfDaySchema.nullable().optional(),
  endTime: TimeOfDaySchema.nullable().optional(),
  timezone: NonEmptyStringSchema.optional(),
})
export type UpdateUserStatusScheduleBody = z.infer<
  typeof UpdateUserStatusScheduleBodySchema
>

export const CreateUserStatusRuleBodySchema = z
  .object({
    scope: UserStatusRuleScopeSchema,
    channelId: ChannelIdSchema.nullable().optional(),
    projectId: ProjectIdSchema.nullable().optional(),
    agentId: AgentIdSchema.nullable().optional(),
    agentEnabled: z.boolean().optional(),
    instructions: StatusInstructionsSchema,
    priority: z.number().int().optional(),
  })
  .superRefine((body, context) => {
    if (body.scope === 'channel' && !body.channelId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Channel rules require channelId',
      })
    }
    if (body.scope === 'project' && !body.projectId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Project rules require projectId',
      })
    }
  })
export type CreateUserStatusRuleBody = z.infer<typeof CreateUserStatusRuleBodySchema>

export const UpdateUserStatusRuleBodySchema = z.object({
  scope: UserStatusRuleScopeSchema.optional(),
  channelId: ChannelIdSchema.nullable().optional(),
  projectId: ProjectIdSchema.nullable().optional(),
  agentId: AgentIdSchema.nullable().optional(),
  agentEnabled: z.boolean().optional(),
  instructions: StatusInstructionsSchema.optional(),
  priority: z.number().int().optional(),
})
export type UpdateUserStatusRuleBody = z.infer<typeof UpdateUserStatusRuleBodySchema>

export const UserRecordSchema = z.object({
  id: UserIdSchema,
  email: z.string().email(),
  displayName: NonEmptyStringSchema,
  role: NonEmptyStringSchema,
  channelIds: z.array(ChannelIdSchema),
  activeStatus: UserActiveStatusSchema.nullable().optional(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
})
export type UserRecord = z.infer<typeof UserRecordSchema>

export const CreateUserBodySchema = z.object({
  email: z.string().email(),
  displayName: NonEmptyStringSchema,
  password: z.string().min(8),
  role: NonEmptyStringSchema.optional(),
  channelIds: z.array(ChannelIdSchema).optional(),
})

// ─── Tasks (human work distribution) ──────────────────────────────────────

export const TaskPrioritySchema = z.enum(['low', 'medium', 'high', 'urgent'])
export type TaskPriority = z.infer<typeof TaskPrioritySchema>

export const TaskRecordSchema = z.object({
  id: TaskIdSchema,
  organizationId: OrganizationIdSchema,
  projectId: ProjectIdSchema.nullable(),
  columnId: z.string().uuid().nullable(),
  iterationId: z.string().uuid().nullable(),
  storyPoints: z.number().int().nullable(),
  agentId: AgentIdSchema.nullable(),
  parentTaskId: TaskIdSchema.nullable(),
  runId: RunIdSchema.nullable(),
  status: TaskStatusSchema,
  priority: TaskPrioritySchema,
  dueDate: TimestampSchema.nullable(),
  title: z.string().nullable(),
  purpose: z.string().nullable(),
  detail: z.string().nullable(),
  assigneeUserId: UserIdSchema.nullable(),
  assigneeAgentId: AgentIdSchema.nullable(),
  assigneeName: z.string().nullable(),
  ownerUserId: UserIdSchema.nullable(),
  ownerName: z.string().nullable(),
  createdByUserId: UserIdSchema.nullable(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
})
export type TaskRecord = z.infer<typeof TaskRecordSchema>

export const CreateTaskBodySchema = z.object({
  title: NonEmptyStringSchema,
  purpose: z.string().optional(),
  detail: z.string().optional(),
  projectId: ProjectIdSchema.optional(),
  iterationId: z.string().uuid().optional(),
  storyPoints: z.number().int().min(0).optional(),
  priority: TaskPrioritySchema.optional(),
  dueDate: z.coerce.date().nullable().optional(),
  assigneeUserId: UserIdSchema.optional(),
  assigneeAgentId: AgentIdSchema.optional(),
  ownerUserId: UserIdSchema.optional(),
})

export const UpdateTaskBodySchema = z.object({
  title: NonEmptyStringSchema.optional(),
  purpose: z.string().nullable().optional(),
  detail: z.string().nullable().optional(),
  priority: TaskPrioritySchema.optional(),
  dueDate: z.coerce.date().nullable().optional(),
  storyPoints: z.number().int().min(0).nullable().optional(),
})

export const SetTaskIterationBodySchema = z.object({
  iterationId: z.string().uuid().nullable(),
})

// Assignment is to a person (assigneeUserId) or an agent (assigneeAgentId);
// the two are mutually exclusive. Both null/absent clears the assignment.
export const AssignTaskBodySchema = z.object({
  assigneeUserId: UserIdSchema.nullable().optional(),
  assigneeAgentId: AgentIdSchema.nullable().optional(),
})

export const TransitionTaskBodySchema = z.object({
  status: TaskStatusSchema,
})

export const AssignableUserSchema = z.object({
  id: UserIdSchema,
  displayName: NonEmptyStringSchema,
})
export type AssignableUser = z.infer<typeof AssignableUserSchema>

export const MoveTaskBodySchema = z.object({
  columnId: z.string().uuid(),
})

// ─── Boards (per-project columns + style) ─────────────────────────────────

export const BoardStyleSchema = z.enum(['kanban', 'scrum'])
export type BoardStyle = z.infer<typeof BoardStyleSchema>

export const ColumnCategorySchema = z.enum(['todo', 'in_progress', 'review', 'done'])
export type ColumnCategory = z.infer<typeof ColumnCategorySchema>

export const BoardColumnRecordSchema = z.object({
  id: z.string().uuid(),
  projectId: ProjectIdSchema,
  name: NonEmptyStringSchema,
  category: ColumnCategorySchema,
  position: z.number().int(),
})
export type BoardColumnRecord = z.infer<typeof BoardColumnRecordSchema>

export const ProjectBoardRecordSchema = z.object({
  style: BoardStyleSchema,
  columns: BoardColumnRecordSchema.array(),
})
export type ProjectBoardRecord = z.infer<typeof ProjectBoardRecordSchema>

export const UpdateBoardBodySchema = z.object({
  style: BoardStyleSchema,
})

export const CreateColumnBodySchema = z.object({
  name: NonEmptyStringSchema,
  category: ColumnCategorySchema,
  position: z.number().int().optional(),
})

export const UpdateColumnBodySchema = z.object({
  name: NonEmptyStringSchema.optional(),
  category: ColumnCategorySchema.optional(),
  position: z.number().int().optional(),
})

// ─── Iterations (scrum sprints) ───────────────────────────────────────────

export const IterationStatusSchema = z.enum(['planned', 'active', 'completed'])
export type IterationStatusValue = z.infer<typeof IterationStatusSchema>

export const IterationRecordSchema = z.object({
  id: z.string().uuid(),
  projectId: ProjectIdSchema,
  name: NonEmptyStringSchema,
  goal: z.string().nullable(),
  status: IterationStatusSchema,
  startDate: z.string().nullable(),
  endDate: z.string().nullable(),
  capacity: z.number().int().nullable(),
  position: z.number().int(),
  completedAt: z.string().nullable(),
  taskCount: z.number().int(),
  pointsTotal: z.number().int(),
  pointsDone: z.number().int(),
})
export type IterationRecord = z.infer<typeof IterationRecordSchema>

export const CreateIterationBodySchema = z.object({
  name: NonEmptyStringSchema,
  goal: z.string().optional(),
  startDate: z.string().optional(),
  endDate: z.string().optional(),
  capacity: z.number().int().positive().optional(),
})

export const UpdateIterationBodySchema = z.object({
  name: NonEmptyStringSchema.optional(),
  goal: z.string().nullable().optional(),
  startDate: z.string().nullable().optional(),
  endDate: z.string().nullable().optional(),
  capacity: z.number().int().positive().nullable().optional(),
  action: z.enum(['start', 'complete']).optional(),
})

export const ProjectInsightsRecordSchema = z.object({
  velocity: z
    .object({ iterationId: z.string().uuid(), name: z.string(), points: z.number() })
    .array(),
  burndown: z
    .object({
      iterationId: z.string().uuid(),
      name: z.string(),
      totalPoints: z.number(),
      days: z
        .object({ date: z.string(), remaining: z.number(), ideal: z.number() })
        .array(),
    })
    .nullable(),
})
export type ProjectInsightsRecord = z.infer<typeof ProjectInsightsRecordSchema>

// ─── Ops health (observability) ───────────────────────────────────────────

export const WorkerHealthStatusSchema = z.enum(['up', 'stale', 'down'])
export type WorkerHealthStatus = z.infer<typeof WorkerHealthStatusSchema>

export const OpsWorkerHealthSchema = z.object({
  status: WorkerHealthStatusSchema,
  activeRunners: z.number().int().nonnegative(),
  lastHeartbeatAt: z.string().nullable(),
  heartbeatAgeSeconds: z.number().int().nonnegative().nullable(),
})

export const OpsDeadJobSchema = z.object({
  id: z.string(),
  topic: z.string(),
  attempt: z.number().int().nonnegative(),
  maxAttempts: z.number().int().positive(),
  errorMessage: z.string().nullable(),
  enqueuedAt: TimestampSchema,
})

export const OpsDeadLetterSchema = z.object({
  id: z.string(),
  subject: z.string().nullable(),
  attempts: z.number().int().nonnegative(),
  createdAt: TimestampSchema,
})

export const OpsHealthResponseSchema = z.object({
  worker: OpsWorkerHealthSchema,
  queue: z.object({
    pending: z.number().int().nonnegative(),
    processing: z.number().int().nonnegative(),
    done: z.number().int().nonnegative(),
    dead: z.number().int().nonnegative(),
  }),
  deadJobs: z.array(OpsDeadJobSchema),
  deadLetters: z.object({
    count: z.number().int().nonnegative(),
    recent: z.array(OpsDeadLetterSchema),
  }),
})
export type OpsHealthResponse = z.infer<typeof OpsHealthResponseSchema>

export const ReadinessResponseSchema = z.object({
  ready: z.boolean(),
  checks: z.object({
    database: z.boolean(),
    worker: WorkerHealthStatusSchema,
  }),
})
export type ReadinessResponse = z.infer<typeof ReadinessResponseSchema>

// ─── Budget (spend enforcement) ───────────────────────────────────────────

export const BudgetModeSchema = z.enum(['off', 'warn', 'enforce', 'degrade', 'unlimited'])
export const BudgetScopeTypeSchema = z.enum(['organization', 'project', 'team'])
export const BudgetPeriodSchema = z.enum(['weekly', 'monthly', 'yearly'])
export const BudgetScopeIdSchema = z.string().uuid()

export const BudgetStatusResponseSchema = z.object({
  scopeType: BudgetScopeTypeSchema,
  scopeId: z.string(),
  mode: BudgetModeSchema,
  period: BudgetPeriodSchema,
  costLimitUsd: z.number().nonnegative().nullable(),
  tokenLimit: z.number().int().nonnegative().nullable(),
  spentUsd: z.number().nonnegative(),
  spentTokens: z.number().int().nonnegative(),
  // Read side is lenient (the strict 1–100 bound is enforced on the write schema
  // below) so an out-of-range stored value can never 500 the status read.
  warnThresholdPercent: z.number().int(),
  blockHumansWhenOver: z.boolean(),
  degradeModel: z.string().nullable(),
  degradeProvider: z.string().nullable(),
  level: z.enum(['ok', 'warn', 'over']),
  percentUsed: z.number().int().nonnegative().nullable(),
  costTrackingActive: z.boolean(),
})

export const SetBudgetBodySchema = z
  .object({
    scopeType: BudgetScopeTypeSchema,
    scopeId: BudgetScopeIdSchema,
    costLimitUsd: z.number().nonnegative().nullable(),
    tokenLimit: z.number().int().nonnegative().nullable(),
    mode: BudgetModeSchema,
    period: BudgetPeriodSchema,
    warnThresholdPercent: z.number().int().min(1).max(100),
    blockHumansWhenOver: z.boolean(),
    degradeModel: z.string().min(1).nullable(),
    degradeProvider: z.string().min(1).nullable(),
  })
  // Degrade mode is meaningless without a fallback model; reject the config rather
  // than letting checkBudget silently fall back to allowing over-budget runs.
  .superRefine((value, ctx) => {
    if (value.mode === 'degrade' && !value.degradeModel) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['degradeModel'],
        message: 'degradeModel is required when mode is degrade',
      })
    }
  })
