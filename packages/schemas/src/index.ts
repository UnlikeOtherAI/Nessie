import { z } from 'zod'

const TimestampSchema = z.string().min(1)
const NonEmptyStringSchema = z.string().min(1)

const createUuidBrandSchema = <TBrand extends string>() => z.string().uuid().brand<TBrand>()

export const OrganizationIdSchema = createUuidBrandSchema<'OrganizationId'>()
export type OrganizationId = z.infer<typeof OrganizationIdSchema>
export const UserIdSchema = createUuidBrandSchema<'UserId'>()
export type UserId = z.infer<typeof UserIdSchema>
export const ProjectIdSchema = createUuidBrandSchema<'ProjectId'>()
export type ProjectId = z.infer<typeof ProjectIdSchema>
export const TeamIdSchema = createUuidBrandSchema<'TeamId'>()
export type TeamId = z.infer<typeof TeamIdSchema>
export const ChannelIdSchema = createUuidBrandSchema<'ChannelId'>()
export type ChannelId = z.infer<typeof ChannelIdSchema>
export const AgentIdSchema = createUuidBrandSchema<'AgentId'>()
export type AgentId = z.infer<typeof AgentIdSchema>
export const AgentCategoryIdSchema = createUuidBrandSchema<'AgentCategoryId'>()
export type AgentCategoryId = z.infer<typeof AgentCategoryIdSchema>
export const ThreadIdSchema = createUuidBrandSchema<'ThreadId'>()
export type ThreadId = z.infer<typeof ThreadIdSchema>
export const RunIdSchema = createUuidBrandSchema<'RunId'>()
export type RunId = z.infer<typeof RunIdSchema>
export const TaskIdSchema = createUuidBrandSchema<'TaskId'>()
export type TaskId = z.infer<typeof TaskIdSchema>
export const ThoughtIdSchema = createUuidBrandSchema<'ThoughtId'>()
export type ThoughtId = z.infer<typeof ThoughtIdSchema>
export const ThoughtRecallIdSchema = createUuidBrandSchema<'ThoughtRecallId'>()
export type ThoughtRecallId = z.infer<typeof ThoughtRecallIdSchema>

// ─── Phase 2 Branded IDs ────────────────────────────────────────────────────
export const ApprovalIdSchema = createUuidBrandSchema<'ApprovalId'>()
export type ApprovalId = z.infer<typeof ApprovalIdSchema>
export const AuditLogIdSchema = createUuidBrandSchema<'AuditLogId'>()
export type AuditLogId = z.infer<typeof AuditLogIdSchema>
export const PolicyIdSchema = createUuidBrandSchema<'PolicyId'>()
export type PolicyId = z.infer<typeof PolicyIdSchema>
export const PolicyBindingIdSchema = createUuidBrandSchema<'PolicyBindingId'>()
export type PolicyBindingId = z.infer<typeof PolicyBindingIdSchema>
export const TokenLedgerEventIdSchema = createUuidBrandSchema<'TokenLedgerEventId'>()
export type TokenLedgerEventId = z.infer<typeof TokenLedgerEventIdSchema>
export const ModelPricingProfileIdSchema = createUuidBrandSchema<'ModelPricingProfileId'>()
export type ModelPricingProfileId = z.infer<typeof ModelPricingProfileIdSchema>
export const InferenceProviderIdSchema = createUuidBrandSchema<'InferenceProviderId'>()
export type InferenceProviderId = z.infer<typeof InferenceProviderIdSchema>
export const InferenceCredentialBindingIdSchema =
  createUuidBrandSchema<'InferenceCredentialBindingId'>()
export type InferenceCredentialBindingId = z.infer<
  typeof InferenceCredentialBindingIdSchema
>
export const InferenceModelIdSchema = createUuidBrandSchema<'InferenceModelId'>()
export type InferenceModelId = z.infer<typeof InferenceModelIdSchema>
export const InferenceCapabilityOverrideIdSchema =
  createUuidBrandSchema<'InferenceCapabilityOverrideId'>()
export type InferenceCapabilityOverrideId = z.infer<
  typeof InferenceCapabilityOverrideIdSchema
>
export const InferenceRoutingProfileIdSchema =
  createUuidBrandSchema<'InferenceRoutingProfileId'>()
export type InferenceRoutingProfileId = z.infer<
  typeof InferenceRoutingProfileIdSchema
>
export const ToolMediatorProfileIdSchema =
  createUuidBrandSchema<'ToolMediatorProfileId'>()
export type ToolMediatorProfileId = z.infer<typeof ToolMediatorProfileIdSchema>
export const InferenceEvalSuiteIdSchema =
  createUuidBrandSchema<'InferenceEvalSuiteId'>()
export type InferenceEvalSuiteId = z.infer<typeof InferenceEvalSuiteIdSchema>
export const InferenceEvalRunIdSchema =
  createUuidBrandSchema<'InferenceEvalRunId'>()
export type InferenceEvalRunId = z.infer<typeof InferenceEvalRunIdSchema>

export const parseOrganizationId = (value: string): OrganizationId =>
  OrganizationIdSchema.parse(value)
export const parseUserId = (value: string): UserId => UserIdSchema.parse(value)
export const parseProjectId = (value: string): ProjectId => ProjectIdSchema.parse(value)
export const parseTeamId = (value: string): TeamId => TeamIdSchema.parse(value)
export const parseChannelId = (value: string): ChannelId => ChannelIdSchema.parse(value)
export const parseAgentId = (value: string): AgentId => AgentIdSchema.parse(value)
export const parseAgentCategoryId = (value: string): AgentCategoryId =>
  AgentCategoryIdSchema.parse(value)
export const parseThreadId = (value: string): ThreadId => ThreadIdSchema.parse(value)
export const parseRunId = (value: string): RunId => RunIdSchema.parse(value)
export const parseTaskId = (value: string): TaskId => TaskIdSchema.parse(value)
export const parseThoughtId = (value: string): ThoughtId => ThoughtIdSchema.parse(value)
export const parseThoughtRecallId = (value: string): ThoughtRecallId =>
  ThoughtRecallIdSchema.parse(value)
export const parseApprovalId = (value: string): ApprovalId =>
  ApprovalIdSchema.parse(value)
export const parseAuditLogId = (value: string): AuditLogId =>
  AuditLogIdSchema.parse(value)
export const parsePolicyId = (value: string): PolicyId => PolicyIdSchema.parse(value)
export const parsePolicyBindingId = (value: string): PolicyBindingId =>
  PolicyBindingIdSchema.parse(value)
export const parseTokenLedgerEventId = (value: string): TokenLedgerEventId =>
  TokenLedgerEventIdSchema.parse(value)
export const parseModelPricingProfileId = (value: string): ModelPricingProfileId =>
  ModelPricingProfileIdSchema.parse(value)
export const parseInferenceProviderId = (value: string): InferenceProviderId =>
  InferenceProviderIdSchema.parse(value)
export const parseInferenceCredentialBindingId = (
  value: string,
): InferenceCredentialBindingId => InferenceCredentialBindingIdSchema.parse(value)
export const parseInferenceModelId = (value: string): InferenceModelId =>
  InferenceModelIdSchema.parse(value)
export const parseInferenceCapabilityOverrideId = (
  value: string,
): InferenceCapabilityOverrideId => InferenceCapabilityOverrideIdSchema.parse(value)
export const parseInferenceRoutingProfileId = (
  value: string,
): InferenceRoutingProfileId => InferenceRoutingProfileIdSchema.parse(value)
export const parseToolMediatorProfileId = (
  value: string,
): ToolMediatorProfileId => ToolMediatorProfileIdSchema.parse(value)
export const parseInferenceEvalSuiteId = (value: string): InferenceEvalSuiteId =>
  InferenceEvalSuiteIdSchema.parse(value)
export const parseInferenceEvalRunId = (value: string): InferenceEvalRunId =>
  InferenceEvalRunIdSchema.parse(value)

export type ApiResponse<T> = {
  data: T
  meta?: PaginationMeta
}

export type ApiError = {
  error: {
    code: string
    message: string
    field?: string
    details?: unknown
  }
}

export const ApiErrorSchema = z.object({
  error: z.object({
    code: NonEmptyStringSchema,
    message: NonEmptyStringSchema,
    field: NonEmptyStringSchema.optional(),
    details: z.unknown().optional(),
  }),
})

export const PaginationDirectionSchema = z.enum(['forward', 'backward'])
export type PaginationDirection = z.infer<typeof PaginationDirectionSchema>

export const PaginationParamsSchema = z.object({
  cursor: z.string().optional(),
  limit: z.number().int().min(1).max(200).optional(),
  direction: PaginationDirectionSchema.optional(),
})
export type PaginationParams = z.infer<typeof PaginationParamsSchema>

export const PaginationMetaSchema = z.object({
  cursor: z.string().nullable(),
  total: z.number().int().nonnegative().optional(),
  hasMore: z.boolean(),
})
export type PaginationMeta = z.infer<typeof PaginationMetaSchema>

export const createApiResponseSchema = <TOutput>(
  dataSchema: z.ZodType<TOutput>,
) =>
  z.object({
    data: dataSchema,
    meta: PaginationMetaSchema.optional(),
  })

export const AgentCategoryVisibilitySchema = z.enum(['public', 'private'])
export type AgentCategoryVisibility = z.infer<typeof AgentCategoryVisibilitySchema>

export const AgentStatusSchema = z.enum([
  'idle',
  'thinking',
  'executing',
  'waiting_approval',
  'error',
  'offline',
])
export type AgentStatus = z.infer<typeof AgentStatusSchema>

export const AgentTriggerTypeSchema = z.enum([
  'manual',
  'scheduled',
  'webhook',
  'event',
  'interval',
])
export type AgentTriggerType = z.infer<typeof AgentTriggerTypeSchema>

export const RunStatusSchema = z.enum([
  'pending',
  'running',
  'waiting_approval',
  'completed',
  'failed',
  'cancelled',
])
export type RunStatus = z.infer<typeof RunStatusSchema>

export const TaskStatusSchema = z.enum([
  'inbox',
  'assigned',
  'in_progress',
  'review',
  'done',
  'failed',
  'cancelled',
  'awaiting_approval',
])
export type TaskStatus = z.infer<typeof TaskStatusSchema>

export const MessageRoleSchema = z.enum(['user', 'assistant', 'system'])
export type MessageRole = z.infer<typeof MessageRoleSchema>

export type SseEventMap = {
  'stream.start': { runId: RunId; threadId: ThreadId }
  'stream.delta': { runId: RunId; content: string }
  'stream.done': { runId: RunId; messageId: string }
  'message.reaction': { messageId: string; agentId?: AgentId; userId?: string; emoji: string }
}

export type WsEventMap = {
  'agent.status': {
    agentId: AgentId
    status: AgentStatus
    since: string
    currentRunId?: RunId
    currentToolName?: string
    currentToolStartedAt?: string
  }
  'agent.tool.start': {
    agentId: AgentId
    runId: RunId
    toolName: string
    inputSummary: string
  }
  'agent.tool.end': {
    agentId: AgentId
    runId: RunId
    toolName: string
    durationMs: number
    success: boolean
  }
  'agent.spawned': { parentId: AgentId; childId: AgentId; taskId: TaskId }
  'run.updated': { runId: RunId; agentId: AgentId; status: RunStatus }
  'task.updated': { taskId: TaskId; status: TaskStatus }
  'approval.needed': {
    taskId: TaskId
    approvalId: string
    agentId: AgentId
    action: string
    reason: string
  }
  'approval.resolved': {
    approvalId: string
    taskId: TaskId
    agentId: AgentId
    outcome: 'approved' | 'rejected' | 'expired'
    resolverId?: string
    resolvedAt: string
  }
  'message.new': {
    agentId: AgentId
    messageId: string
    role: MessageRole
    contentPreview: string
    threadId: ThreadId
  }
}

export const StreamStartEventSchema = z.object({
  runId: RunIdSchema,
  threadId: ThreadIdSchema,
})
export type StreamStartEvent = z.infer<typeof StreamStartEventSchema>
export const StreamDeltaEventSchema = z.object({
  runId: RunIdSchema,
  content: z.string(),
})
export type StreamDeltaEvent = z.infer<typeof StreamDeltaEventSchema>
export const StreamDoneEventSchema = z.object({
  runId: RunIdSchema,
  messageId: NonEmptyStringSchema,
})
export type StreamDoneEvent = z.infer<typeof StreamDoneEventSchema>
export const MessageReactionEventSchema = z.object({
  messageId: NonEmptyStringSchema,
  agentId: AgentIdSchema.optional(),
  userId: z.string().uuid().optional(),
  emoji: z.string(),
})
export type MessageReactionEvent = z.infer<typeof MessageReactionEventSchema>
export const SseEventNameSchema = z.enum(['stream.start', 'stream.delta', 'stream.done', 'message.reaction'])

export const SseEventSchema = z.discriminatedUnion('event', [
  z.object({
    event: z.literal('stream.start'),
    data: StreamStartEventSchema,
  }),
  z.object({
    event: z.literal('stream.delta'),
    data: StreamDeltaEventSchema,
  }),
  z.object({
    event: z.literal('stream.done'),
    data: StreamDoneEventSchema,
  }),
  z.object({
    event: z.literal('message.reaction'),
    data: MessageReactionEventSchema,
  }),
])
export type SseEvent = z.infer<typeof SseEventSchema>

export const AgentStatusEventSchema = z.object({
  agentId: AgentIdSchema,
  status: AgentStatusSchema,
  since: TimestampSchema,
  currentRunId: RunIdSchema.optional(),
  currentToolName: z.string().optional(),
  currentToolStartedAt: TimestampSchema.optional(),
})
export type AgentStatusEvent = z.infer<typeof AgentStatusEventSchema>
export const AgentToolStartEventSchema = z.object({
  agentId: AgentIdSchema,
  runId: RunIdSchema,
  toolName: NonEmptyStringSchema,
  inputSummary: z.string(),
})
export type AgentToolStartEvent = z.infer<typeof AgentToolStartEventSchema>
export const AgentToolEndEventSchema = z.object({
  agentId: AgentIdSchema,
  runId: RunIdSchema,
  toolName: NonEmptyStringSchema,
  durationMs: z.number().int().nonnegative(),
  success: z.boolean(),
})
export type AgentToolEndEvent = z.infer<typeof AgentToolEndEventSchema>
export const AgentSpawnedEventSchema = z.object({
  parentId: AgentIdSchema,
  childId: AgentIdSchema,
  taskId: TaskIdSchema,
})
export type AgentSpawnedEvent = z.infer<typeof AgentSpawnedEventSchema>
export const RunUpdatedEventSchema = z.object({
  runId: RunIdSchema,
  agentId: AgentIdSchema,
  status: RunStatusSchema,
})
export type RunUpdatedEvent = z.infer<typeof RunUpdatedEventSchema>
export const TaskUpdatedEventSchema = z.object({
  taskId: TaskIdSchema,
  status: TaskStatusSchema,
})
export const ApprovalNeededEventSchema = z.object({
  taskId: TaskIdSchema,
  approvalId: NonEmptyStringSchema,
  agentId: AgentIdSchema,
  action: NonEmptyStringSchema,
  reason: z.string(),
})
export const MessageNewEventSchema = z.object({
  agentId: AgentIdSchema,
  messageId: NonEmptyStringSchema,
  role: MessageRoleSchema,
  contentPreview: z.string(),
  threadId: ThreadIdSchema,
})
export type MessageNewEvent = z.infer<typeof MessageNewEventSchema>
export const ApprovalResolvedEventSchema = z.object({
  approvalId: NonEmptyStringSchema,
  taskId: TaskIdSchema,
  agentId: AgentIdSchema,
  outcome: z.enum(['approved', 'rejected', 'expired']),
  resolverId: NonEmptyStringSchema.optional(),
  resolvedAt: TimestampSchema,
})
export type ApprovalResolvedEvent = z.infer<typeof ApprovalResolvedEventSchema>

export const WsEventNameSchema = z.enum([
  'agent.status',
  'agent.tool.start',
  'agent.tool.end',
  'agent.spawned',
  'run.updated',
  'task.updated',
  'approval.needed',
  'approval.resolved',
  'message.new',
])

export const WsScopeSchema = z.union([
  z.object({
    kind: z.literal('organization'),
    organizationId: OrganizationIdSchema,
  }),
  z.object({
    kind: z.literal('channel'),
    channelId: ChannelIdSchema,
  }),
  z.object({
    kind: z.literal('agent'),
    agentId: AgentIdSchema,
  }),
])
export type WsScope = z.infer<typeof WsScopeSchema>

export const WsSubscribeSchema = z.object({
  type: z.literal('subscribe'),
  scopes: z.array(WsScopeSchema),
})
export type WsSubscribe = z.infer<typeof WsSubscribeSchema>

export const WsSetSubscriptionsSchema = z.object({
  type: z.literal('set_subscriptions'),
  scopes: z.array(WsScopeSchema),
})
export type WsSetSubscriptions = z.infer<typeof WsSetSubscriptionsSchema>

export const WsUnsubscribeSchema = z.object({
  type: z.literal('unsubscribe'),
  scopes: z.array(WsScopeSchema),
})
export type WsUnsubscribe = z.infer<typeof WsUnsubscribeSchema>

export const WsPingSchema = z.object({
  type: z.literal('ping'),
})
export type WsPing = z.infer<typeof WsPingSchema>

export const WsPongSchema = z.object({
  type: z.literal('pong'),
  ts: TimestampSchema,
})
export type WsPong = z.infer<typeof WsPongSchema>

export const WsErrorSchema = z.object({
  type: z.literal('error'),
  code: NonEmptyStringSchema,
  message: NonEmptyStringSchema,
})
export type WsError = z.infer<typeof WsErrorSchema>

export const WsSnapshotAgentSchema = z.object({
  agentId: AgentIdSchema,
  status: AgentStatusSchema,
  since: TimestampSchema,
  currentRunId: RunIdSchema.optional(),
  currentToolName: z.string().optional(),
  currentToolStartedAt: TimestampSchema.optional(),
})
export const WsSnapshotSchema = z.object({
  agents: z.array(WsSnapshotAgentSchema),
})
export type WsSnapshot = z.infer<typeof WsSnapshotSchema>

export const WsSubscribedSchema = z.object({
  type: z.literal('subscribed'),
  scopes: z.array(WsScopeSchema),
  snapshot: WsSnapshotSchema,
})
export type WsSubscribed = z.infer<typeof WsSubscribedSchema>

export const WsEventSchema = z.union([
  z.object({
    type: z.literal('event'),
    event: z.literal('agent.status'),
    data: AgentStatusEventSchema,
    ts: TimestampSchema,
  }),
  z.object({
    type: z.literal('event'),
    event: z.literal('agent.tool.start'),
    data: AgentToolStartEventSchema,
    ts: TimestampSchema,
  }),
  z.object({
    type: z.literal('event'),
    event: z.literal('agent.tool.end'),
    data: AgentToolEndEventSchema,
    ts: TimestampSchema,
  }),
  z.object({
    type: z.literal('event'),
    event: z.literal('agent.spawned'),
    data: AgentSpawnedEventSchema,
    ts: TimestampSchema,
  }),
  z.object({
    type: z.literal('event'),
    event: z.literal('run.updated'),
    data: RunUpdatedEventSchema,
    ts: TimestampSchema,
  }),
  z.object({
    type: z.literal('event'),
    event: z.literal('task.updated'),
    data: TaskUpdatedEventSchema,
    ts: TimestampSchema,
  }),
  z.object({
    type: z.literal('event'),
    event: z.literal('approval.needed'),
    data: ApprovalNeededEventSchema,
    ts: TimestampSchema,
  }),
  z.object({
    type: z.literal('event'),
    event: z.literal('approval.resolved'),
    data: ApprovalResolvedEventSchema,
    ts: TimestampSchema,
  }),
  z.object({
    type: z.literal('event'),
    event: z.literal('message.new'),
    data: MessageNewEventSchema,
    ts: TimestampSchema,
  }),
])

export const WsClientMessageSchema = z.union([
  WsSubscribeSchema,
  WsSetSubscriptionsSchema,
  WsUnsubscribeSchema,
  WsPingSchema,
])
export const WsServerMessageSchema = z.union([
  WsSubscribedSchema,
  WsEventSchema,
  WsPongSchema,
  WsErrorSchema,
])

export const AuthProviderResponseTypeSchema = z.enum([
  'oidc',
  'saml',
  'uoa',
  'local-bootstrap',
  'custom',
])
export type AuthProviderResponseType = z.infer<typeof AuthProviderResponseTypeSchema>

export const MeUserSchema = z.object({
  id: UserIdSchema,
  email: z.string().email(),
  displayName: NonEmptyStringSchema,
  avatarUrl: z.string().url().optional(),
  pronouns: z.string().optional(),
  roleIds: z.array(NonEmptyStringSchema),
})
export type MeUser = z.infer<typeof MeUserSchema>

export const MeSessionSchema = z.object({
  sessionId: NonEmptyStringSchema,
  issuedAt: TimestampSchema,
  expiresAt: TimestampSchema.optional(),
})
export type MeSession = z.infer<typeof MeSessionSchema>

export const MeContextSchema = z.object({
  organizationId: OrganizationIdSchema,
  projectId: ProjectIdSchema,
  teamId: TeamIdSchema,
  channelId: ChannelIdSchema.nullish(),
  bootstrapMode: z.boolean(),
})
export type MeContext = z.infer<typeof MeContextSchema>

export const MeAuthSchema = z.object({
  providerId: NonEmptyStringSchema,
  providerType: AuthProviderResponseTypeSchema,
  autoRedirectToSso: z.boolean(),
})
export type MeAuth = z.infer<typeof MeAuthSchema>

export const MeMembershipSchema = z.object({
  organizationId: OrganizationIdSchema,
  organizationName: z.string().optional(),
  role: z.string(),
  projects: z.array(z.object({
    projectId: ProjectIdSchema,
    projectName: z.string().optional(),
    teams: z.array(z.object({
      teamId: TeamIdSchema,
      teamName: z.string().optional(),
    })),
  })),
})
export type MeMembership = z.infer<typeof MeMembershipSchema>

export const MeResponseSchema = z.object({
  user: MeUserSchema,
  session: MeSessionSchema,
  context: MeContextSchema,
  auth: MeAuthSchema,
  memberships: z.array(MeMembershipSchema).optional(),
})
export type MeResponse = z.infer<typeof MeResponseSchema>

export const ToolCallEntrySchema = z.object({
  toolName: NonEmptyStringSchema,
  runId: RunIdSchema,
  startedAt: TimestampSchema,
  endedAt: TimestampSchema.optional(),
  durationMs: z.number().int().nonnegative().optional(),
  success: z.boolean().optional(),
  inputSummary: z.string(),
  outputPreview: z.string().optional(),
})
export type ToolCallEntry = z.infer<typeof ToolCallEntrySchema>

export const AgentStatusResponseSchema = z.object({
  agentId: AgentIdSchema,
  status: AgentStatusSchema,
  since: TimestampSchema,
  currentRunId: RunIdSchema.optional(),
  currentToolName: z.string().optional(),
  currentToolStartedAt: TimestampSchema.optional(),
  activeSubAgents: z.array(
    z.object({
      agentId: AgentIdSchema,
      status: AgentStatusSchema,
      taskId: TaskIdSchema,
    }),
  ),
  lastActivityAt: TimestampSchema,
})
export type AgentStatusResponse = z.infer<typeof AgentStatusResponseSchema>

export const AgentActivityResponseSchema = z.object({
  agentId: AgentIdSchema,
  status: AgentStatusSchema,
  currentRun: z
    .object({
      runId: RunIdSchema,
      status: RunStatusSchema,
      startedAt: TimestampSchema,
      toolCalls: z.array(ToolCallEntrySchema),
    })
    .optional(),
  recentToolCalls: z.array(ToolCallEntrySchema),
  subAgents: z.array(
    z.object({
      agentId: AgentIdSchema,
      name: NonEmptyStringSchema,
      status: AgentStatusSchema,
      taskId: TaskIdSchema,
      purpose: z.string().optional(),
    }),
  ),
})
export type AgentActivityResponse = z.infer<typeof AgentActivityResponseSchema>

export const AgentMessageSchema = z.object({
  messageId: NonEmptyStringSchema,
  role: MessageRoleSchema,
  contentPreview: z.string(),
  fullContent: z.string(),
  threadId: ThreadIdSchema,
  timestamp: TimestampSchema,
})
export type AgentMessage = z.infer<typeof AgentMessageSchema>

export const AgentChildSchema = z.object({
  agentId: AgentIdSchema,
  name: NonEmptyStringSchema,
  status: AgentStatusSchema,
  taskId: TaskIdSchema,
  purpose: z.string().optional(),
  parentAgentId: AgentIdSchema,
  spawnedAt: TimestampSchema,
})
export type AgentChild = z.infer<typeof AgentChildSchema>

export const VerificationFactorTypeSchema = z.enum([
  'email_otp',
  'email_link',
  'totp',
  'recovery_code',
  'webauthn',
])
export type VerificationFactorType = z.infer<typeof VerificationFactorTypeSchema>

export const AccessActorSchema = z.object({
  actorType: z.enum(['user', 'agent', 'service']),
  actorId: NonEmptyStringSchema,
  roles: z.array(NonEmptyStringSchema).optional(),
})
export type AccessActor = z.infer<typeof AccessActorSchema>

export const TenantContextSchema = z.object({
  organizationId: OrganizationIdSchema,
  projectId: ProjectIdSchema.optional(),
  teamId: TeamIdSchema.optional(),
  channelId: ChannelIdSchema.optional(),
})
export type TenantContext = z.infer<typeof TenantContextSchema>

export const ActionContextSchema = z.object({
  teamId: TeamIdSchema.optional(),
  channelId: ChannelIdSchema.optional(),
  agentId: AgentIdSchema.optional(),
  toolId: NonEmptyStringSchema.optional(),
  taskId: TaskIdSchema.optional(),
  sessionId: NonEmptyStringSchema.optional(),
  threadId: ThreadIdSchema.optional(),
  requestId: NonEmptyStringSchema,
  correlationId: NonEmptyStringSchema.optional(),
  purpose: z.string().optional(),
})
export type ActionContext = z.infer<typeof ActionContextSchema>

export const AccessContextSchema = z.object({
  actor: AccessActorSchema,
  tenant: TenantContextSchema,
  actionContext: ActionContextSchema,
})
export type AccessContext = z.infer<typeof AccessContextSchema>

export const AuthorizedActionContextSchema = AccessContextSchema.extend({
  approval: z
    .object({
      approverId: NonEmptyStringSchema.optional(),
      approvalId: NonEmptyStringSchema.optional(),
      approvalProof: NonEmptyStringSchema.optional(),
      approvalContext: z.record(z.string(), z.string()).optional(),
    })
    .optional(),
  verification: z
    .object({
      challengeId: NonEmptyStringSchema,
      proof: NonEmptyStringSchema,
      factorType: VerificationFactorTypeSchema.optional(),
    })
    .optional(),
})
export type AuthorizedActionContext = z.infer<typeof AuthorizedActionContextSchema>

export const RunExecuteJobPayloadSchema = z.object({
  actorContext: AuthorizedActionContextSchema,
  agentId: AgentIdSchema,
  messageId: NonEmptyStringSchema,
  parentPlanId: z.string().uuid().optional(),
  parentPlanStepId: z.string().uuid().optional(),
  parentWorkflowRunId: z.string().uuid().optional(),
  parentWorkflowStepRunId: z.string().uuid().optional(),
  promptOverride: z.string().min(1).optional(),
  runId: RunIdSchema,
  taskId: TaskIdSchema,
  threadId: ThreadIdSchema,
})
export type RunExecuteJobPayload = z.infer<typeof RunExecuteJobPayloadSchema>

export const WorkflowRunExecuteJobPayloadSchema = z.object({
  actorContext: AuthorizedActionContextSchema,
  workflowRunId: z.string().uuid(),
})
export type WorkflowRunExecuteJobPayload = z.infer<typeof WorkflowRunExecuteJobPayloadSchema>

export const ExecutionEnvironmentAllocateJobPayloadSchema = z.object({
  actorContext: AuthorizedActionContextSchema,
  instanceId: z.string().uuid(),
})
export type ExecutionEnvironmentAllocateJobPayload = z.infer<
  typeof ExecutionEnvironmentAllocateJobPayloadSchema
>

export const ExecutionEnvironmentTerminateJobPayloadSchema = z.object({
  actorContext: AuthorizedActionContextSchema,
  instanceId: z.string().uuid(),
})
export type ExecutionEnvironmentTerminateJobPayload = z.infer<
  typeof ExecutionEnvironmentTerminateJobPayloadSchema
>

export const TriggerEventDispatchJobPayloadSchema = z.object({
  actorContext: AuthorizedActionContextSchema,
  dedupeKey: NonEmptyStringSchema.optional(),
  eventType: NonEmptyStringSchema,
  payload: z.record(z.unknown()),
  source: z.string().min(1),
})
export type TriggerEventDispatchJobPayload = z.infer<typeof TriggerEventDispatchJobPayloadSchema>

// ─── Phase 2: Policy Enforcement ────────────────────────────────────────────

export const PolicyScopeSchema = z.enum([
  'organization',
  'project',
  'team',
  'channel',
  'agent',
  'tool',
  'user',
])
export type PolicyScope = z.infer<typeof PolicyScopeSchema>

export const PolicyResourceTypeSchema = z.enum([
  'agent',
  'channel',
  'project',
  'tool',
  'session',
  'task',
  'review',
  'approval',
  'admin',
  'secret',
])
export type PolicyResourceType = z.infer<typeof PolicyResourceTypeSchema>

export const PolicyActionSchema = z.enum([
  'view',
  'invoke',
  'create',
  'edit',
  'assign',
  'approve',
  'review',
  'search',
  'export',
  'admin',
  'resolve',
  'rotate',
  'revoke',
  'bind',
  'link',
  'reindex',
  'summarize',
  'read',
  'import',
  'grant',
  'enroll',
  'challenge',
])
export type PolicyAction = z.infer<typeof PolicyActionSchema>

export const PolicyEffectSchema = z.enum(['allow', 'deny'])
export type PolicyEffect = z.infer<typeof PolicyEffectSchema>

export const PolicyConditionsSchema = z.object({
  timeWindow: z
    .object({
      startHour: z.number().int().min(0).max(23),
      endHour: z.number().int().min(0).max(23),
      daysOfWeek: z.array(z.number().int().min(0).max(6)),
    })
    .optional(),
  ipRanges: z.array(z.string()).optional(),
  requiresApproval: z.boolean().optional(),
  approvalActionType: z.string().optional(),
  maxUsagePerHour: z.number().int().positive().optional(),
})
export type PolicyConditions = z.infer<typeof PolicyConditionsSchema>

export const PolicyDecisionSchema = z.object({
  allowed: z.boolean(),
  policyRuleId: z.string().optional(),
  policySource: z.string(),
  reasonCode: z.enum([
    'EXPLICIT_DENY',
    'NO_MATCHING_ALLOW',
    'CHANNEL_MEMBERSHIP_REQUIRED',
    'APPROVAL_REQUIRED',
    'CONDITIONS_NOT_MET',
    'SCOPE_NOT_AVAILABLE',
    'ALLOWED',
  ]),
  requiresApproval: z.boolean().optional(),
  approvalActionType: z.string().optional(),
})
export type PolicyDecision = z.infer<typeof PolicyDecisionSchema>

export const PolicyRuleResponseSchema = z.object({
  id: PolicyIdSchema,
  organizationId: OrganizationIdSchema,
  scope: PolicyScopeSchema,
  scopeId: NonEmptyStringSchema,
  resourceType: PolicyResourceTypeSchema,
  action: PolicyActionSchema,
  effect: PolicyEffectSchema,
  priority: z.number().int(),
  conditions: PolicyConditionsSchema.nullable(),
  createdBy: NonEmptyStringSchema,
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
  bindings: z.array(
    z.object({
      id: PolicyBindingIdSchema,
      actorType: z.enum(['user', 'agent', 'service', 'role']),
      actorId: NonEmptyStringSchema,
    }),
  ),
})
export type PolicyRuleResponse = z.infer<typeof PolicyRuleResponseSchema>

export const EffectivePolicySchema = z.object({
  decisions: z.array(
    z.object({
      resourceType: PolicyResourceTypeSchema,
      action: PolicyActionSchema,
      decision: PolicyDecisionSchema,
    }),
  ),
})
export type EffectivePolicy = z.infer<typeof EffectivePolicySchema>

// ─── Phase 2: Approval Gating ──────────────────────────────────────────────

export const ApprovalStatusSchema = z.enum([
  'pending',
  'approved',
  'rejected',
  'expired',
])
export type ApprovalStatus = z.infer<typeof ApprovalStatusSchema>

export const ApprovalRequestResponseSchema = z.object({
  id: ApprovalIdSchema,
  organizationId: OrganizationIdSchema,
  projectId: ProjectIdSchema.optional(),
  teamId: TeamIdSchema.optional(),
  channelId: ChannelIdSchema.optional(),
  taskId: TaskIdSchema.optional(),
  runId: RunIdSchema.optional(),
  agentId: AgentIdSchema,
  requesterId: NonEmptyStringSchema,
  action: NonEmptyStringSchema,
  reason: z.string(),
  context: z.record(z.string(), z.unknown()).optional(),
  status: ApprovalStatusSchema,
  resolverId: NonEmptyStringSchema.optional(),
  resolvedAt: TimestampSchema.optional(),
  resolution: z.enum(['approved', 'rejected']).optional(),
  resolutionNote: z.string().optional(),
  continuationToken: NonEmptyStringSchema,
  expiresAt: TimestampSchema,
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
})
export type ApprovalRequestResponse = z.infer<typeof ApprovalRequestResponseSchema>

export const ResolveApprovalBodySchema = z.object({
  resolution: z.enum(['approved', 'rejected']),
  note: z.string().max(2000).optional(),
})
export type ResolveApprovalBody = z.infer<typeof ResolveApprovalBodySchema>

// ─── Phase 2: Audit Trail ──────────────────────────────────────────────────

export const AuditActionSchema = z.enum([
  'auth.bootstrap',
  'auth.login',
  'auth.logout',
  'auth.login_failed',
  'user.created',
  'user.updated',
  'user.deleted',
  'user.role_changed',
  'organization.updated',
  'project.created',
  'project.updated',
  'project.deleted',
  'project.member_added',
  'project.member_removed',
  'team.created',
  'team.updated',
  'team.deleted',
  'team.member_added',
  'team.member_removed',
  'channel.created',
  'channel.updated',
  'channel.deleted',
  'channel.member_added',
  'channel.member_removed',
  'channel.visibility_changed',
  'agent.created',
  'agent.updated',
  'agent.retired',
  'agent.restored',
  'agent.deleted',
  'agent.bound',
  'agent.unbound',
  'tool.granted',
  'tool.revoked',
  'approval.created',
  'approval.approved',
  'approval.rejected',
  'approval.expired',
  'pricing.created',
  'pricing.updated',
  'pricing.deleted',
  'policy.created',
  'policy.updated',
  'policy.deleted',
  'policy.evaluated',
])
export type AuditAction = z.infer<typeof AuditActionSchema>

export const AuditOutcomeSchema = z.enum(['success', 'denied', 'error'])
export type AuditOutcome = z.infer<typeof AuditOutcomeSchema>

export const AuditActorTypeSchema = z.enum(['user', 'agent', 'service', 'system'])
export type AuditActorType = z.infer<typeof AuditActorTypeSchema>

export const AuditLogResponseSchema = z.object({
  id: AuditLogIdSchema,
  organizationId: OrganizationIdSchema,
  projectId: ProjectIdSchema.optional(),
  teamId: TeamIdSchema.optional(),
  channelId: ChannelIdSchema.optional(),
  actorType: AuditActorTypeSchema,
  actorId: NonEmptyStringSchema,
  action: AuditActionSchema,
  resourceType: NonEmptyStringSchema,
  resourceId: NonEmptyStringSchema.optional(),
  outcome: AuditOutcomeSchema,
  reason: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  requestId: NonEmptyStringSchema,
  ipAddress: z.string().optional(),
  userAgent: z.string().optional(),
  createdAt: TimestampSchema,
})
export type AuditLogResponse = z.infer<typeof AuditLogResponseSchema>

export const AuditLogSummarySchema = z.object({
  groupBy: NonEmptyStringSchema,
  entries: z.array(
    z.object({
      key: NonEmptyStringSchema,
      count: z.number().int().nonnegative(),
    }),
  ),
})
export type AuditLogSummary = z.infer<typeof AuditLogSummarySchema>

// ─── Phase 2: Token Ledger ─────────────────────────────────────────────────

export const TokenUsageSchema = z.object({
  inputTokens: z.number().int().nonnegative().optional(),
  outputTokens: z.number().int().nonnegative().optional(),
  cachedInputTokens: z.number().int().nonnegative().optional(),
  cachedOutputTokens: z.number().int().nonnegative().optional(),
  cacheReadTokens: z.number().int().nonnegative().optional(),
  cacheWriteTokens: z.number().int().nonnegative().optional(),
  totalTokens: z.number().int().nonnegative().optional(),
})
export type TokenUsage = z.infer<typeof TokenUsageSchema>

export const OperationTypeSchema = z.enum([
  'chat',
  'completion',
  'embedding',
  'translation',
  'reasoning',
  'tool-translation',
  'other',
])
export type OperationType = z.infer<typeof OperationTypeSchema>

export const PricingSourceSchema = z.enum([
  'provider-default',
  'org-override',
  'team-override',
  'manual',
])
export type PricingSource = z.infer<typeof PricingSourceSchema>

export const PricingSnapshotSchema = z.object({
  profileId: NonEmptyStringSchema,
  source: PricingSourceSchema,
  currency: NonEmptyStringSchema,
  inputPerMillion: z.number().nonnegative().optional(),
  outputPerMillion: z.number().nonnegative().optional(),
  cachedInputPerMillion: z.number().nonnegative().optional(),
  cachedOutputPerMillion: z.number().nonnegative().optional(),
  cacheReadPerMillion: z.number().nonnegative().optional(),
  cacheWritePerMillion: z.number().nonnegative().optional(),
})
export type PricingSnapshot = z.infer<typeof PricingSnapshotSchema>

export const TokenLedgerEventResponseSchema = z.object({
  eventId: TokenLedgerEventIdSchema,
  occurredAt: TimestampSchema,
  organizationId: OrganizationIdSchema,
  projectId: ProjectIdSchema.optional(),
  teamId: TeamIdSchema.optional(),
  channelId: ChannelIdSchema.optional(),
  threadId: ThreadIdSchema.optional(),
  sessionId: NonEmptyStringSchema.optional(),
  taskId: TaskIdSchema.optional(),
  agentId: AgentIdSchema.optional(),
  actorId: NonEmptyStringSchema,
  requestId: NonEmptyStringSchema,
  correlationId: NonEmptyStringSchema.optional(),
  provider: NonEmptyStringSchema,
  model: NonEmptyStringSchema,
  operationType: OperationTypeSchema,
  usage: TokenUsageSchema,
  providerReportedCost: z
    .object({
      amount: z.number().nonnegative(),
      currency: NonEmptyStringSchema,
    })
    .optional(),
  pricingSnapshot: PricingSnapshotSchema.optional(),
  estimatedCost: z
    .object({
      amount: z.number().nonnegative(),
      currency: NonEmptyStringSchema,
    })
    .optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
})
export type TokenLedgerEventResponse = z.infer<typeof TokenLedgerEventResponseSchema>

export const TokenUsageSummarySchema = z.object({
  totalInputTokens: z.number().int().nonnegative(),
  totalOutputTokens: z.number().int().nonnegative(),
  totalTokens: z.number().int().nonnegative(),
  totalEstimatedCost: z.number().nonnegative(),
  totalProviderReportedCost: z.number().nonnegative(),
  currency: NonEmptyStringSchema,
  breakdowns: z.array(
    z.object({
      key: NonEmptyStringSchema,
      inputTokens: z.number().int().nonnegative(),
      outputTokens: z.number().int().nonnegative(),
      totalTokens: z.number().int().nonnegative(),
      estimatedCost: z.number().nonnegative(),
      providerReportedCost: z.number().nonnegative(),
    }),
  ),
})
export type TokenUsageSummary = z.infer<typeof TokenUsageSummarySchema>

export const MonthlyEstimateSchema = z.object({
  currentMonthUsage: z.number().nonnegative(),
  currentMonthCost: z.number().nonnegative(),
  projectedMonthlyCost: z.number().nonnegative(),
  currency: NonEmptyStringSchema,
  daysElapsed: z.number().int().positive(),
  daysInMonth: z.number().int().positive(),
})
export type MonthlyEstimate = z.infer<typeof MonthlyEstimateSchema>

export const ModelPricingProfileResponseSchema = z.object({
  profileId: ModelPricingProfileIdSchema,
  organizationId: OrganizationIdSchema,
  provider: NonEmptyStringSchema,
  modelPattern: NonEmptyStringSchema,
  currency: NonEmptyStringSchema,
  source: PricingSourceSchema,
  inputPerMillion: z.number().nonnegative().optional(),
  outputPerMillion: z.number().nonnegative().optional(),
  cachedInputPerMillion: z.number().nonnegative().optional(),
  cachedOutputPerMillion: z.number().nonnegative().optional(),
  cacheReadPerMillion: z.number().nonnegative().optional(),
  cacheWritePerMillion: z.number().nonnegative().optional(),
  effectiveFrom: TimestampSchema,
  effectiveTo: TimestampSchema.optional(),
})
export type ModelPricingProfileResponse = z.infer<typeof ModelPricingProfileResponseSchema>

// ─── Phase 2: Inference Connector And Orchestration ───────────────────────

export const ToolCallingModeSchema = z.enum([
  'native',
  'prompt-translated',
  'disabled',
])
export type ToolCallingMode = z.infer<typeof ToolCallingModeSchema>

export const StructuredOutputModeSchema = z.enum([
  'native-json',
  'prompt-json',
  'text-only',
])
export type StructuredOutputMode = z.infer<typeof StructuredOutputModeSchema>

export const SystemPromptModeSchema = z.enum(['native', 'fold-into-user'])
export type SystemPromptMode = z.infer<typeof SystemPromptModeSchema>

export const ToolResultModeSchema = z.enum([
  'native-tool-message',
  'context-block',
])
export type ToolResultMode = z.infer<typeof ToolResultModeSchema>

export const ProviderHealthStatusSchema = z.enum([
  'healthy',
  'degraded',
  'unreachable',
  'unknown',
])
export type ProviderHealthStatus = z.infer<typeof ProviderHealthStatusSchema>

export const NormalizedFinishReasonSchema = z.enum([
  'stop',
  'length',
  'tool-call',
  'content-filter',
  'error',
  'other',
])
export type NormalizedFinishReason = z.infer<typeof NormalizedFinishReasonSchema>

export const ProviderMessageContentPartSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('text'),
    text: z.string(),
  }),
  z.object({
    type: z.literal('image'),
    imageUrl: z.string().url(),
  }),
])
export type ProviderMessageContentPart = z.infer<
  typeof ProviderMessageContentPartSchema
>

export const ProviderMessageRoleSchema = z.enum([
  'system',
  'user',
  'assistant',
  'tool',
])
export type ProviderMessageRole = z.infer<typeof ProviderMessageRoleSchema>

export const ProviderMessageSchema = z.object({
  role: ProviderMessageRoleSchema,
  content: z.union([z.string(), z.array(ProviderMessageContentPartSchema)]),
  name: NonEmptyStringSchema.optional(),
  toolCallId: NonEmptyStringSchema.optional(),
})
export type ProviderMessage = z.infer<typeof ProviderMessageSchema>

export const ToolSchemaDescriptorSchema = z.object({
  toolName: NonEmptyStringSchema,
  description: z.string(),
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
export type StructuredOutputDescriptor = z.infer<
  typeof StructuredOutputDescriptorSchema
>

export const ModelCapabilitySourceSchema = z.enum(['static', 'live', 'manual'])
export type ModelCapabilitySource = z.infer<typeof ModelCapabilitySourceSchema>

export const CapabilityResolutionSourceSchema = z.enum([
  'override',
  'static',
  'live',
  'manual',
])
export type CapabilityResolutionSource = z.infer<
  typeof CapabilityResolutionSourceSchema
>

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
  displayName: NonEmptyStringSchema.optional(),
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
  source: ModelCapabilitySourceSchema,
  discoveredAt: TimestampSchema,
  lastVerifiedAt: TimestampSchema.optional(),
})
export type ModelCapabilitySnapshot = z.infer<typeof ModelCapabilitySnapshotSchema>

export const CapabilityResolutionSchema = z.object({
  effectiveSnapshot: ModelCapabilitySnapshotSchema,
  effectiveSource: CapabilityResolutionSourceSchema,
  overrideActive: z.boolean(),
})
export type CapabilityResolution = z.infer<typeof CapabilityResolutionSchema>

export const InvocationUsageSchema = TokenUsageSchema
export type InvocationUsage = z.infer<typeof InvocationUsageSchema>

export const InvocationOperationTypeSchema = OperationTypeSchema
export type InvocationOperationType = z.infer<typeof InvocationOperationTypeSchema>

export const InvocationRecordSchema = z.object({
  invocationId: NonEmptyStringSchema,
  requestId: NonEmptyStringSchema,
  correlationId: NonEmptyStringSchema.optional(),
  provider: NonEmptyStringSchema,
  model: NonEmptyStringSchema,
  operationType: InvocationOperationTypeSchema,
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

export const ProviderToolCallSchema = z.object({
  toolCallId: NonEmptyStringSchema,
  toolName: NonEmptyStringSchema,
  arguments: z.record(z.unknown()),
  reason: z.string().optional(),
})
export type ProviderToolCall = z.infer<typeof ProviderToolCallSchema>

export const ProviderInvocationRequestSchema = z.object({
  requestId: NonEmptyStringSchema,
  correlationId: NonEmptyStringSchema.optional(),
  model: NonEmptyStringSchema,
  messages: z.array(ProviderMessageSchema),
  tools: z.array(ToolSchemaDescriptorSchema).optional(),
  expectedStructuredOutput: StructuredOutputDescriptorSchema.optional(),
  maxOutputTokens: z.number().int().positive().optional(),
  metadata: z.record(z.unknown()).optional(),
})
export type ProviderInvocationRequest = z.infer<
  typeof ProviderInvocationRequestSchema
>

export const ProviderInvocationResultSchema = z.object({
  outputText: z.string(),
  toolCalls: z.array(ProviderToolCallSchema),
  structuredOutput: z.unknown().optional(),
  finishReason: NormalizedFinishReasonSchema.optional(),
  invocation: InvocationRecordSchema,
})
export type ProviderInvocationResult = z.infer<
  typeof ProviderInvocationResultSchema
>

export const ProviderStreamEventSchema = z.discriminatedUnion('type', [
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

export const InferenceRequestRouteSchema = z.union([
  z
    .object({
      provider: NonEmptyStringSchema,
      model: NonEmptyStringSchema,
    })
    .strict(),
  z
    .object({
      routingProfileId: InferenceRoutingProfileIdSchema,
    })
    .strict(),
])
export type InferenceRequestRoute = z.infer<typeof InferenceRequestRouteSchema>

export const InferenceRequestSchema = z.object({
  requestId: NonEmptyStringSchema,
  correlationId: NonEmptyStringSchema.optional(),
  actorContext: AuthorizedActionContextSchema,
  route: InferenceRequestRouteSchema,
  messages: z.array(ProviderMessageSchema),
  tools: z.array(ToolSchemaDescriptorSchema).optional(),
  expectedStructuredOutput: StructuredOutputDescriptorSchema.optional(),
  metadata: z.record(z.unknown()).optional(),
})
export type InferenceRequest = z.infer<typeof InferenceRequestSchema>

export const ProviderHealthReportSchema = z.object({
  status: ProviderHealthStatusSchema,
  checkedAt: TimestampSchema,
  latencyMs: z.number().int().nonnegative().optional(),
  message: z.string().optional(),
})
export type ProviderHealthReport = z.infer<typeof ProviderHealthReportSchema>

export const ProviderConnectorMetaSchema = z.object({
  provider: NonEmptyStringSchema,
  displayName: NonEmptyStringSchema,
  supportsModelDiscovery: z.boolean(),
})
export type ProviderConnectorMeta = z.infer<typeof ProviderConnectorMetaSchema>

export const ProviderConnectionConfigSchema = z.object({
  providerKey: NonEmptyStringSchema,
  baseUrl: z.string().url().optional(),
  credentialBindingId: InferenceCredentialBindingIdSchema.optional(),
})
export type ProviderConnectionConfig = z.infer<
  typeof ProviderConnectionConfigSchema
>

export const StageExecutionStatusSchema = z.enum([
  'started',
  'completed',
  'failed',
])
export type StageExecutionStatus = z.infer<typeof StageExecutionStatusSchema>

export const InferenceStreamEventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('output_text.delta'),
    text: z.string(),
  }),
  z.object({
    type: z.literal('stage.status'),
    stageId: NonEmptyStringSchema,
    status: StageExecutionStatusSchema,
  }),
])
export type InferenceStreamEvent = z.infer<typeof InferenceStreamEventSchema>

export const RoutingModeSchema = z.enum([
  'single',
  'fallback',
  'committee',
  'pipeline',
  'shadow',
])
export type RoutingMode = z.infer<typeof RoutingModeSchema>

export const StreamPolicySchema = z.enum(['primary-only', 'buffered-judge'])
export type StreamPolicy = z.infer<typeof StreamPolicySchema>

export const StageRoleSchema = z.enum([
  'advisor',
  'executor',
  'synthesizer',
  'judge',
  'shadow',
])
export type StageRole = z.infer<typeof StageRoleSchema>

export const InferenceExposureSchema = z.enum(['standard', 'admin-only'])
export type InferenceExposure = z.infer<typeof InferenceExposureSchema>

export const LifecycleStatusSchema = z.enum([
  'draft',
  'approved',
  'deprecated',
])
export type LifecycleStatus = z.infer<typeof LifecycleStatusSchema>

export const RouteStageSchema = z.object({
  id: NonEmptyStringSchema,
  role: StageRoleSchema,
  provider: NonEmptyStringSchema,
  model: NonEmptyStringSchema,
  toolCallingMode: ToolCallingModeSchema.optional(),
  inputFrom: z.array(NonEmptyStringSchema).optional(),
  userVisible: z.boolean().optional(),
  maxAttempts: z.number().int().positive().optional(),
})
export type RouteStage = z.infer<typeof RouteStageSchema>

export const RoutingProfileSchema = z.object({
  id: InferenceRoutingProfileIdSchema,
  label: NonEmptyStringSchema,
  enabled: z.boolean(),
  exposure: InferenceExposureSchema,
  mode: RoutingModeSchema,
  streamPolicy: StreamPolicySchema,
  toolMediatorId: ToolMediatorProfileIdSchema.optional(),
  stages: z.array(RouteStageSchema),
})
export type RoutingProfile = z.infer<typeof RoutingProfileSchema>

export const CandidateOutputSchema = z.object({
  stageId: NonEmptyStringSchema,
  stageRole: StageRoleSchema,
  outputText: z.string(),
  structuredOutput: z.unknown().optional(),
  toolCalls: z.array(ToolCallIntentSchema).optional(),
  invocationIds: z.array(NonEmptyStringSchema),
  finishReason: NormalizedFinishReasonSchema.optional(),
  metadata: z.record(z.unknown()).optional(),
})
export type CandidateOutput = z.infer<typeof CandidateOutputSchema>

export const StageExecutionInputSchema = z.object({
  baseMessages: z.array(ProviderMessageSchema),
  upstream: z.array(CandidateOutputSchema),
})
export type StageExecutionInput = z.infer<typeof StageExecutionInputSchema>

export const StepMetadataStepSchema = z.enum([
  'primary',
  'fallback',
  'advisor',
  'synthesizer',
  'shadow',
  'judge',
  'tool-translation',
])
export type StepMetadataStep = z.infer<typeof StepMetadataStepSchema>

export const StepMetadataSchema = z.object({
  step: StepMetadataStepSchema,
  stageRole: StageRoleSchema,
  routingMode: RoutingModeSchema,
  stageId: NonEmptyStringSchema.optional(),
  retryOfInvocationId: NonEmptyStringSchema.optional(),
})
export type StepMetadata = z.infer<typeof StepMetadataSchema>

export const MultiProviderResultStatusSchema = z.enum(['completed', 'failed'])
export type MultiProviderResultStatus = z.infer<
  typeof MultiProviderResultStatusSchema
>

export const AnswerOwnerSchema = z.object({
  stageId: NonEmptyStringSchema,
  stageRole: StageRoleSchema,
  provider: NonEmptyStringSchema,
  model: NonEmptyStringSchema,
  invocationId: NonEmptyStringSchema,
})
export type AnswerOwner = z.infer<typeof AnswerOwnerSchema>

export const ToolExecutionOwnerSchema = z.object({
  stageId: NonEmptyStringSchema,
  provider: NonEmptyStringSchema,
  model: NonEmptyStringSchema,
  invocationId: NonEmptyStringSchema,
})
export type ToolExecutionOwner = z.infer<typeof ToolExecutionOwnerSchema>

export const MultiProviderFailureSchema = z.object({
  code: NonEmptyStringSchema,
  message: NonEmptyStringSchema,
  stageId: NonEmptyStringSchema.optional(),
})
export type MultiProviderFailure = z.infer<typeof MultiProviderFailureSchema>

export const MultiProviderResultSchema = z.object({
  requestId: NonEmptyStringSchema,
  correlationId: NonEmptyStringSchema.optional(),
  status: MultiProviderResultStatusSchema,
  finalAnswer: z.string().optional(),
  structuredOutput: z.unknown().optional(),
  answerOwner: AnswerOwnerSchema.optional(),
  toolExecutionOwner: ToolExecutionOwnerSchema.nullable(),
  failure: MultiProviderFailureSchema.optional(),
  invocations: z.array(InvocationRecordSchema),
})
export type MultiProviderResult = z.infer<typeof MultiProviderResultSchema>

export const InferenceProviderConnectorKindSchema = z.enum([
  'compiled',
  'openai-compatible',
])
export type InferenceProviderConnectorKind = z.infer<
  typeof InferenceProviderConnectorKindSchema
>

export const InferenceProviderSchema = z.object({
  id: InferenceProviderIdSchema,
  organizationId: OrganizationIdSchema,
  providerKey: NonEmptyStringSchema,
  connectorKind: InferenceProviderConnectorKindSchema,
  displayName: NonEmptyStringSchema,
  enabled: z.boolean(),
  lifecycleStatus: LifecycleStatusSchema,
  baseUrl: z.string().url().optional(),
  supportsModelDiscovery: z.boolean(),
  activeCredentialBindingId: InferenceCredentialBindingIdSchema.optional(),
  healthStatus: ProviderHealthStatusSchema,
  lastCheckedAt: TimestampSchema,
  createdByActorId: NonEmptyStringSchema,
  updatedByActorId: NonEmptyStringSchema,
  approvedByActorId: NonEmptyStringSchema.optional(),
  approvedAt: TimestampSchema.optional(),
})
export type InferenceProvider = z.infer<typeof InferenceProviderSchema>

export const InferenceCredentialBindingSchema = z.object({
  id: InferenceCredentialBindingIdSchema,
  organizationId: OrganizationIdSchema,
  providerId: InferenceProviderIdSchema,
  label: NonEmptyStringSchema,
  authSecretRef: NonEmptyStringSchema,
  createdByActorId: NonEmptyStringSchema,
  createdAt: TimestampSchema,
  revokedAt: TimestampSchema.optional(),
})
export type InferenceCredentialBinding = z.infer<
  typeof InferenceCredentialBindingSchema
>

export const InferenceModelSchema = z.object({
  id: InferenceModelIdSchema,
  organizationId: OrganizationIdSchema,
  providerId: InferenceProviderIdSchema,
  model: NonEmptyStringSchema,
  displayName: NonEmptyStringSchema.optional(),
  enabled: z.boolean(),
  lifecycleStatus: LifecycleStatusSchema,
  capabilitySnapshot: ModelCapabilitySnapshotSchema,
  source: ModelCapabilitySourceSchema,
  discoveredAt: TimestampSchema,
  lastVerifiedAt: TimestampSchema.optional(),
  createdByActorId: NonEmptyStringSchema,
  approvedByActorId: NonEmptyStringSchema.optional(),
  approvedAt: TimestampSchema.optional(),
})
export type InferenceModel = z.infer<typeof InferenceModelSchema>

export const InferenceCapabilityOverrideSchema = z.object({
  id: InferenceCapabilityOverrideIdSchema,
  organizationId: OrganizationIdSchema,
  providerId: InferenceProviderIdSchema,
  model: NonEmptyStringSchema,
  lifecycleStatus: LifecycleStatusSchema,
  overrideSnapshot: ModelCapabilitySnapshotSchema,
  createdByActorId: NonEmptyStringSchema,
  createdAt: TimestampSchema,
  clearedAt: TimestampSchema.optional(),
  approvedByActorId: NonEmptyStringSchema.optional(),
  approvedAt: TimestampSchema.optional(),
})
export type InferenceCapabilityOverride = z.infer<
  typeof InferenceCapabilityOverrideSchema
>

export const ToolMediatorProfileSchema = z.object({
  id: ToolMediatorProfileIdSchema,
  organizationId: OrganizationIdSchema,
  label: NonEmptyStringSchema,
  enabled: z.boolean(),
  translatorProvider: NonEmptyStringSchema,
  translatorModel: NonEmptyStringSchema,
  mediatorConfig: z.record(z.unknown()),
  createdByActorId: NonEmptyStringSchema,
  approvedByActorId: NonEmptyStringSchema.optional(),
  approvedAt: TimestampSchema.optional(),
})
export type ToolMediatorProfile = z.infer<typeof ToolMediatorProfileSchema>

export const InferenceRoutingProfileSchema = RoutingProfileSchema.extend({
  organizationId: OrganizationIdSchema,
  lifecycleStatus: LifecycleStatusSchema,
  createdByActorId: NonEmptyStringSchema,
  approvedByActorId: NonEmptyStringSchema.optional(),
  approvedAt: TimestampSchema.optional(),
})
export type InferenceRoutingProfile = z.infer<
  typeof InferenceRoutingProfileSchema
>

export const InferenceEvalDatasetRefSchema = z.object({
  kind: z.enum(['file', 'dataset', 'query']),
  value: NonEmptyStringSchema,
})
export type InferenceEvalDatasetRef = z.infer<
  typeof InferenceEvalDatasetRefSchema
>

export const InferenceEvalSummarySchema = z.object({
  totalCases: z.number().int().nonnegative(),
  passedCases: z.number().int().nonnegative(),
  failedCases: z.number().int().nonnegative(),
  score: z.number(),
  blockingFailures: z.array(z.unknown()),
})
export type InferenceEvalSummary = z.infer<typeof InferenceEvalSummarySchema>

export const InferenceEvalCaseResultSchema = z.object({
  caseId: NonEmptyStringSchema,
  input: z.unknown(),
  expected: z.unknown().optional(),
  actual: z.unknown(),
  verdict: NonEmptyStringSchema,
  invocationIds: z.array(NonEmptyStringSchema),
})
export type InferenceEvalCaseResult = z.infer<
  typeof InferenceEvalCaseResultSchema
>

export const InferenceEvalRunStatusSchema = z.enum([
  'queued',
  'running',
  'completed',
  'failed',
  'cancelled',
])
export type InferenceEvalRunStatus = z.infer<
  typeof InferenceEvalRunStatusSchema
>

export const InferenceEvalSuiteSchema = z.object({
  id: InferenceEvalSuiteIdSchema,
  organizationId: OrganizationIdSchema,
  label: NonEmptyStringSchema,
  exposure: InferenceExposureSchema,
  enabled: z.boolean(),
  datasetRef: InferenceEvalDatasetRefSchema,
  targetRoutingProfileId: InferenceRoutingProfileIdSchema,
  judgeRoutingProfileId: InferenceRoutingProfileIdSchema.optional(),
  lifecycleStatus: LifecycleStatusSchema,
  createdByActorId: NonEmptyStringSchema,
  approvedByActorId: NonEmptyStringSchema.optional(),
  approvedAt: TimestampSchema.optional(),
})
export type InferenceEvalSuite = z.infer<typeof InferenceEvalSuiteSchema>

export const InferenceEvalRunSchema = z.object({
  id: InferenceEvalRunIdSchema,
  organizationId: OrganizationIdSchema,
  evalSuiteId: InferenceEvalSuiteIdSchema,
  startedByActorId: NonEmptyStringSchema,
  startedAt: TimestampSchema,
  finishedAt: TimestampSchema.optional(),
  status: InferenceEvalRunStatusSchema,
  summary: InferenceEvalSummarySchema,
  result: z.record(z.unknown()),
  caseResults: z.array(InferenceEvalCaseResultSchema),
  targetProfileSnapshot: RoutingProfileSchema,
  judgeProfileSnapshot: RoutingProfileSchema.optional(),
})
export type InferenceEvalRun = z.infer<typeof InferenceEvalRunSchema>

export const ToolIntentTranslationRequestSchema = z.object({
  requestId: NonEmptyStringSchema,
  correlationId: NonEmptyStringSchema.optional(),
  rawIntentBlock: z.string(),
  toolSchemas: z.array(ToolSchemaDescriptorSchema),
})
export type ToolIntentTranslationRequest = z.infer<
  typeof ToolIntentTranslationRequestSchema
>

export const StructuredOutputRepairRequestSchema = z.object({
  requestId: NonEmptyStringSchema,
  correlationId: NonEmptyStringSchema.optional(),
  rawOutput: z.string(),
  targetSchema: StructuredOutputDescriptorSchema,
})
export type StructuredOutputRepairRequest = z.infer<
  typeof StructuredOutputRepairRequestSchema
>

export interface ProviderConnector {
  readonly provider: string
  getProviderMeta(): Promise<ProviderConnectorMeta>
  listModels(): Promise<ModelCapabilitySnapshot[]>
  getModelCapabilities(model: string): Promise<ModelCapabilitySnapshot>
  checkHealth(): Promise<ProviderHealthReport>
  invoke(request: ProviderInvocationRequest): Promise<ProviderInvocationResult>
  stream?(
    request: ProviderInvocationRequest,
  ): AsyncGenerator<ProviderStreamEvent, ProviderInvocationResult, undefined>
  close(): void
}

export interface ConnectorRegistry {
  getConfigured(config: ProviderConnectionConfig): Promise<ProviderConnector>
  listRegistered(): Promise<string[]>
}

export interface CapabilityCatalog {
  resolve(provider: string, model: string): Promise<CapabilityResolution>
}

export interface ToolMediator {
  translateToolIntent(
    input: ToolIntentTranslationRequest,
  ): Promise<ToolCallIntent>
  repairStructuredOutput(
    input: StructuredOutputRepairRequest,
  ): Promise<unknown>
}

export interface InferenceService {
  run(request: InferenceRequest): Promise<MultiProviderResult>
  stream?(
    request: InferenceRequest,
  ): AsyncGenerator<InferenceStreamEvent, MultiProviderResult, undefined>
}

// ─── Phase 2: Channel Visibility ───────────────────────────────────────────

export const ChannelVisibilitySchema = z.enum(['public', 'protected', 'private'])
export type ChannelVisibility = z.infer<typeof ChannelVisibilitySchema>

// ─── Memory Schemas ─────────────────────────────────────────────────────────

export const ThoughtVisibilitySchema = z.enum([
  'private',
  'channel',
  'team',
  'project',
  'organization',
])
export type ThoughtVisibility = z.infer<typeof ThoughtVisibilitySchema>

export const SensitivityTierSchema = z.enum(['normal', 'sensitive', 'restricted'])
export type SensitivityTier = z.infer<typeof SensitivityTierSchema>

export const ReasoningTypeSchema = z.enum([
  'decision',
  'evaluation',
  'constraint',
  'pattern',
  'correction',
  'validation',
])
export type ReasoningType = z.infer<typeof ReasoningTypeSchema>

export const OutcomeStatusSchema = z.enum([
  'pending',
  'successful',
  'partially',
  'failed',
  'superseded',
])
export type OutcomeStatus = z.infer<typeof OutcomeStatusSchema>

export const ThoughtLinkRelationSchema = z.enum([
  'supersedes',
  'derived_from',
  'contradicts',
  'supports',
  'relates_to',
])
export type ThoughtLinkRelation = z.infer<typeof ThoughtLinkRelationSchema>
export const ThoughtSearchModeSchema = z.enum(['semantic', 'lexical', 'hybrid'])
export type ThoughtSearchMode = z.infer<typeof ThoughtSearchModeSchema>
export const ThoughtRecallUserSignalSchema = z.enum([
  'helpful',
  'irrelevant',
  'harmful',
])
export type ThoughtRecallUserSignal = z.infer<typeof ThoughtRecallUserSignalSchema>

export const CaptureThoughtBodySchema = z.object({
  content: z.string().min(1).max(50000),
  visibility: ThoughtVisibilitySchema.optional(),
  sensitivityTier: SensitivityTierSchema.optional(),
  importance: z.number().min(0).max(1).optional(),
  projectId: ProjectIdSchema.optional(),
  teamId: TeamIdSchema.optional(),
  channelId: ChannelIdSchema.optional(),
  threadId: ThreadIdSchema.optional(),
})
export type CaptureThoughtBody = z.infer<typeof CaptureThoughtBodySchema>

export const SearchThoughtsBodySchema = z.object({
  query: z.string().min(1).max(2000),
  threshold: z.number().min(0).max(1).optional(),
  limit: z.number().int().min(1).max(100).optional(),
  includeReasoning: z.boolean().optional(),
  mode: ThoughtSearchModeSchema.optional(),
})
export type SearchThoughtsBody = z.infer<typeof SearchThoughtsBodySchema>

export const RecordOutcomeBodySchema = z.object({
  outcome: z.enum(['successful', 'partially', 'failed']),
  outcomeNotes: z.string().max(5000).optional(),
})
export type RecordOutcomeBody = z.infer<typeof RecordOutcomeBodySchema>

export const LinkThoughtsBodySchema = z.object({
  targetId: ThoughtIdSchema,
  relation: ThoughtLinkRelationSchema,
  metadata: z.record(z.string(), z.unknown()).optional(),
})
export type LinkThoughtsBody = z.infer<typeof LinkThoughtsBodySchema>

export const RecordThoughtRecallSignalBodySchema = z.object({
  userSignal: ThoughtRecallUserSignalSchema,
})
export type RecordThoughtRecallSignalBody = z.infer<
  typeof RecordThoughtRecallSignalBodySchema
>
