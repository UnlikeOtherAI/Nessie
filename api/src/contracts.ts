import {
  AgentCategoryIdSchema,
  AgentCategoryVisibilitySchema,
  AgentIdSchema,
  AgentStatusSchema,
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

export const AgentTriggerTypeSchema = z.enum([
  'manual',
  'scheduled',
  'webhook',
  'event',
  'interval',
])
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
  fromAgentId: AgentIdSchema.nullish(),
  toAgentId: AgentIdSchema.nullish(),
  channelId: ChannelIdSchema.nullish(),
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
  subject: z.string().optional(),
  toAgentId: AgentIdSchema.optional(),
})

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
