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
export const ThreadIdSchema = createUuidBrandSchema<'ThreadId'>()
export type ThreadId = z.infer<typeof ThreadIdSchema>
export const RunIdSchema = createUuidBrandSchema<'RunId'>()
export type RunId = z.infer<typeof RunIdSchema>
export const TaskIdSchema = createUuidBrandSchema<'TaskId'>()
export type TaskId = z.infer<typeof TaskIdSchema>

export const parseOrganizationId = (value: string): OrganizationId =>
  OrganizationIdSchema.parse(value)
export const parseUserId = (value: string): UserId => UserIdSchema.parse(value)
export const parseProjectId = (value: string): ProjectId => ProjectIdSchema.parse(value)
export const parseTeamId = (value: string): TeamId => TeamIdSchema.parse(value)
export const parseChannelId = (value: string): ChannelId => ChannelIdSchema.parse(value)
export const parseAgentId = (value: string): AgentId => AgentIdSchema.parse(value)
export const parseThreadId = (value: string): ThreadId => ThreadIdSchema.parse(value)
export const parseRunId = (value: string): RunId => RunIdSchema.parse(value)
export const parseTaskId = (value: string): TaskId => TaskIdSchema.parse(value)

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

export const AgentStatusSchema = z.enum([
  'idle',
  'thinking',
  'executing',
  'waiting_approval',
  'error',
  'offline',
])
export type AgentStatus = z.infer<typeof AgentStatusSchema>

export const RunStatusSchema = z.enum([
  'pending',
  'running',
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
export const StreamDeltaEventSchema = z.object({
  runId: RunIdSchema,
  content: z.string(),
})
export const StreamDoneEventSchema = z.object({
  runId: RunIdSchema,
  messageId: NonEmptyStringSchema,
})
export const SseEventNameSchema = z.enum(['stream.start', 'stream.delta', 'stream.done'])

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
export const AgentToolStartEventSchema = z.object({
  agentId: AgentIdSchema,
  runId: RunIdSchema,
  toolName: NonEmptyStringSchema,
  inputSummary: z.string(),
})
export const AgentToolEndEventSchema = z.object({
  agentId: AgentIdSchema,
  runId: RunIdSchema,
  toolName: NonEmptyStringSchema,
  durationMs: z.number().int().nonnegative(),
  success: z.boolean(),
})
export const AgentSpawnedEventSchema = z.object({
  parentId: AgentIdSchema,
  childId: AgentIdSchema,
  taskId: TaskIdSchema,
})
export const RunUpdatedEventSchema = z.object({
  runId: RunIdSchema,
  agentId: AgentIdSchema,
  status: RunStatusSchema,
})
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
export const WsEventNameSchema = z.enum([
  'agent.status',
  'agent.tool.start',
  'agent.tool.end',
  'agent.spawned',
  'run.updated',
  'task.updated',
  'approval.needed',
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

export const MeResponseSchema = z.object({
  user: MeUserSchema,
  session: MeSessionSchema,
  context: MeContextSchema,
  auth: MeAuthSchema,
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
