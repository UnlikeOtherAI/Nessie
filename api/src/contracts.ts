import {
  AgentCategoryIdSchema,
  AgentCategoryVisibilitySchema,
  AgentIdSchema,
  AgentStatusSchema,
  AgentTriggerTypeSchema,
  AuthProviderResponseTypeSchema,
  ChannelIdSchema,
  MessageRoleSchema,
  OrganizationIdSchema,
  RunIdSchema,
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
  bootstrapUrl: z.literal('/admin/bootstrap'),
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
  visibility: z.enum(['public', 'protected', 'private']),
  organizationId: OrganizationIdSchema,
  teamId: TeamIdSchema,
  defaultThreadId: ThreadIdSchema,
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
})
export type ChannelRecord = z.infer<typeof ChannelRecordSchema>

export const CreateChannelBodySchema = z.object({
  label: NonEmptyStringSchema,
  visibility: z.enum(['public', 'protected', 'private']).optional(),
})

export const AgentRecordSchema = z.object({
  id: AgentIdSchema,
  name: NonEmptyStringSchema,
  role: NonEmptyStringSchema,
  status: AgentStatusSchema,
  currentRunId: RunIdSchema.optional(),
  currentToolName: z.string().optional(),
  currentToolStartedAt: TimestampSchema.optional(),
  lastActivityAt: TimestampSchema,
  systemPrompt: z.string().optional(),
  parentAgentId: AgentIdSchema.nullish(),
  provider: z.string().optional(),
  model: z.string().optional(),
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
  agentId: AgentIdSchema,
  type: AgentTriggerTypeSchema,
  status: AgentTriggerStatusSchema,
  enabled: z.boolean(),
  name: z.string().optional(),
  description: z.string().optional(),
  config: z.record(z.unknown()),
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

export const AgentCategoryRecordSchema = z.object({
  id: AgentCategoryIdSchema,
  name: NonEmptyStringSchema,
  description: z.string().nullable(),
  visibility: AgentCategoryVisibilitySchema,
  organizationId: OrganizationIdSchema,
  createdById: UserIdSchema,
  authorAgentId: AgentIdSchema.nullable(),
  agentIds: z.array(AgentIdSchema),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
})
export type AgentCategoryRecord = z.infer<typeof AgentCategoryRecordSchema>

export const CreateAgentCategoryBodySchema = z.object({
  name: NonEmptyStringSchema,
  description: z.string().optional(),
  visibility: AgentCategoryVisibilitySchema.optional(),
  authorAgentId: AgentIdSchema.optional(),
})

export const UpdateAgentCategoryBodySchema = z.object({
  name: NonEmptyStringSchema.optional(),
  description: z.string().nullable().optional(),
  visibility: AgentCategoryVisibilitySchema.optional(),
  authorAgentId: AgentIdSchema.nullable().optional(),
})

export const AgentCategoryAgentBodySchema = z.object({
  agentId: AgentIdSchema,
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

export const ThreadMessageRecordSchema = z.object({
  id: z.string().uuid(),
  threadId: ThreadIdSchema,
  agentId: AgentIdSchema.nullish(),
  userId: z.string().uuid().nullish(),
  role: MessageRoleSchema,
  content: z.string(),
  createdAt: TimestampSchema,
  reactions: MessageReactionRecordSchema.array().optional(),
})
export type ThreadMessageRecord = z.infer<typeof ThreadMessageRecordSchema>

export const CreateThreadMessageBodySchema = z.object({
  content: NonEmptyStringSchema,
})

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

export const CreateWorkflowRunBodySchema = z.object({
  input: z.record(z.unknown()).optional(),
  triggerId: z.string().uuid().optional(),
  triggerDeliveryId: z.string().uuid().optional(),
  parentRunId: RunIdSchema.optional(),
  planId: z.string().uuid().optional(),
  planStepId: z.string().uuid().optional(),
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

// ─── Designer chat ────────────────────────────────────────────────────────

export const DesignerChatMessageSchema = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.string(),
})

export const DesignerFormStateSchema = z.object({
  name: z.string(),
  role: z.string(),
  systemPrompt: z.string(),
  categoryId: z.string().nullable(),
  provider: z.string(),
  model: z.string(),
  tools: z.record(z.string(), z.boolean()),
})

export const DesignerChatBodySchema = z.object({
  messages: z.array(DesignerChatMessageSchema),
  formState: DesignerFormStateSchema,
})

// ─── Users ────────────────────────────────────────────────────────────────

export const UserRecordSchema = z.object({
  id: UserIdSchema,
  email: z.string().email(),
  displayName: NonEmptyStringSchema,
  role: NonEmptyStringSchema,
  channelIds: z.array(ChannelIdSchema),
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
