import { z } from 'zod'

import {
  AgentIdSchema,
  ChannelIdSchema,
  OrganizationIdSchema,
  type AgentId,
  type ChannelId,
  type RunId,
  RunIdSchema,
  type TaskId,
  TaskIdSchema,
  ThreadIdSchema,
  type ThreadId,
  type UserId,
  UserIdSchema,
} from './ids.js'
import {
  AgentStatusSchema,
  RunStatusSchema,
  TaskStatusSchema,
  type AgentStatus,
  type RunStatus,
  type TaskStatus,
} from './lifecycle.js'
import { MessageRoleSchema, type MessageRole } from './messaging.js'
import { MessageReactionEventSchema } from './realtime-sse.js'
import { NonEmptyStringSchema, TimestampSchema } from './schema-primitives.js'

// WebSocket half of the realtime catalog: presence, agent activity, and message
// lifecycle/cache-invalidation events, plus the client/server envelope. Chat
// streaming belongs on SSE (see realtime-sse.ts). `message.reaction` rides both
// transports, so its schema is defined once on the SSE side and reused here.

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
    agentId?: AgentId
    authorUserId?: UserId
    channelId?: ChannelId
    messageId: string
    role: MessageRole
    // Absent exactly when `restricted` is set — see `MessageNewEventSchema`.
    contentPreview?: string
    restricted?: true
    threadId: ThreadId
  }
  // sp-messaging slice: message lifecycle events
  'message.updated': {
    messageId: string
    threadId: ThreadId
    contentPreview?: string
    restricted?: true
    editedAt: string
  }
  'message.deleted': {
    messageId: string
    threadId: ThreadId
    deletedAt: string
  }
  'message.reaction': { messageId: string; agentId?: AgentId; userId?: string; emoji: string }
  // Message-level reply threads (#233): additive kinds so older clients
  // degrade by ignoring them.
  'message.reply': {
    agentId?: AgentId
    authorUserId?: UserId
    channelId?: ChannelId
    messageId: string
    rootMessageId: string
    role: MessageRole
    // Absent exactly when `restricted` is set — see `MessageReplyEventSchema`.
    contentPreview?: string
    restricted?: true
    threadId: ThreadId
  }
  'message.reply.meta': {
    channelId?: ChannelId
    threadId: ThreadId
    rootMessageId: string
    replyCount: number
    lastReplyAt?: string
    replyParticipantIds: string[]
  }
  'agent.iteration': {
    agentId: string
    iteration: number
    runId: string
  }
  // User alerts (#246): per-recipient events ride the channel scope of the
  // recipient's accessible channel; clients filter on `userId`.
  'alert.created': {
    userId: UserId
    kind: 'mention' | 'task_assigned' | 'knowledge_published'
    messageId?: string
    threadId?: ThreadId
    channelId?: ChannelId
    actorUserId?: UserId
    actorAgentId?: AgentId
    createdAt: string
  }
  'alert.read': {
    userId: UserId
    alertIds: string[]
    channelId?: ChannelId
    readAt: string
  }
}

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
  agentId: AgentIdSchema.optional(),
  authorUserId: UserIdSchema.optional(),
  channelId: ChannelIdSchema.optional(),
  messageId: NonEmptyStringSchema,
  role: MessageRoleSchema,
  // Absent exactly when `restricted` is true: WS scopes are channel- and
  // organization-wide, so a preview would reach every connected member
  // regardless of entitlement. A restricted message publishes content-free and
  // entitled clients refetch through the gated list endpoint. Declaring this
  // optional is load-bearing — `publishWs` parses through `WsEventSchema`, so a
  // required `contentPreview` made the content-free publish throw and fail the
  // run instead of closing the wire.
  contentPreview: z.string().optional(),
  restricted: z.literal(true).optional(),
  threadId: ThreadIdSchema,
})
export type MessageNewEvent = z.infer<typeof MessageNewEventSchema>
// sp-messaging slice: message lifecycle event schemas
export const MessageUpdatedEventSchema = z.object({
  messageId: NonEmptyStringSchema,
  threadId: ThreadIdSchema,
  // Optional for the same reason `message.new`'s is: WS scopes are channel- and
  // organisation-wide, so a preview here reaches every connected member
  // regardless of entitlement. A restricted edit publishes `restricted: true`
  // and no preview; entitled clients refetch through the gated list.
  contentPreview: z.string().optional(),
  restricted: z.literal(true).optional(),
  editedAt: TimestampSchema,
})
export type MessageUpdatedEvent = z.infer<typeof MessageUpdatedEventSchema>
export const MessageDeletedEventSchema = z.object({
  messageId: NonEmptyStringSchema,
  threadId: ThreadIdSchema,
  deletedAt: TimestampSchema,
})
export type MessageDeletedEvent = z.infer<typeof MessageDeletedEventSchema>
// Message-level reply threads (#233): reply-created + root metadata-updated.
export const MessageReplyEventSchema = z.object({
  agentId: AgentIdSchema.optional(),
  authorUserId: UserIdSchema.optional(),
  channelId: ChannelIdSchema.optional(),
  messageId: NonEmptyStringSchema,
  rootMessageId: NonEmptyStringSchema,
  role: MessageRoleSchema,
  // Optional for the same reason as `message.new`: a restricted reply is
  // published content-free rather than previewed to the whole channel.
  contentPreview: z.string().optional(),
  restricted: z.literal(true).optional(),
  threadId: ThreadIdSchema,
})
export type MessageReplyEvent = z.infer<typeof MessageReplyEventSchema>
export const MessageReplyMetaEventSchema = z.object({
  channelId: ChannelIdSchema.optional(),
  threadId: ThreadIdSchema,
  rootMessageId: NonEmptyStringSchema,
  replyCount: z.number().int().nonnegative(),
  lastReplyAt: TimestampSchema.optional(),
  replyParticipantIds: z.array(z.string().uuid()),
})
export type MessageReplyMetaEvent = z.infer<typeof MessageReplyMetaEventSchema>
export const ApprovalResolvedEventSchema = z.object({
  approvalId: NonEmptyStringSchema,
  taskId: TaskIdSchema,
  agentId: AgentIdSchema,
  outcome: z.enum(['approved', 'rejected', 'expired']),
  resolverId: NonEmptyStringSchema.optional(),
  resolvedAt: TimestampSchema,
})
export type ApprovalResolvedEvent = z.infer<typeof ApprovalResolvedEventSchema>

// User alerts (#246): additive kinds per the #225 realtime registry.
export const AlertCreatedEventSchema = z.object({
  userId: UserIdSchema,
  kind: z.enum(['mention', 'task_assigned', 'knowledge_published']),
  messageId: z.string().uuid().optional(),
  threadId: ThreadIdSchema.optional(),
  channelId: ChannelIdSchema.optional(),
  actorUserId: UserIdSchema.optional(),
  actorAgentId: AgentIdSchema.optional(),
  createdAt: TimestampSchema,
})
export type AlertCreatedEvent = z.infer<typeof AlertCreatedEventSchema>
export const AlertReadEventSchema = z.object({
  userId: UserIdSchema,
  alertIds: z.array(z.string().uuid()),
  channelId: ChannelIdSchema.optional(),
  readAt: TimestampSchema,
})
export type AlertReadEvent = z.infer<typeof AlertReadEventSchema>

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
  'message.updated',
  'message.deleted',
  'message.reaction',
  'message.reply',
  'message.reply.meta',
  'agent.iteration',
  'alert.created',
  'alert.read',
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
  z.object({
    type: z.literal('event'),
    event: z.literal('message.updated'),
    data: MessageUpdatedEventSchema,
    ts: TimestampSchema,
  }),
  z.object({
    type: z.literal('event'),
    event: z.literal('message.deleted'),
    data: MessageDeletedEventSchema,
    ts: TimestampSchema,
  }),
  z.object({
    type: z.literal('event'),
    event: z.literal('message.reaction'),
    data: MessageReactionEventSchema,
    ts: TimestampSchema,
  }),
  z.object({
    type: z.literal('event'),
    event: z.literal('message.reply'),
    data: MessageReplyEventSchema,
    ts: TimestampSchema,
  }),
  z.object({
    type: z.literal('event'),
    event: z.literal('message.reply.meta'),
    data: MessageReplyMetaEventSchema,
    ts: TimestampSchema,
  }),
  z.object({
    type: z.literal('event'),
    event: z.literal('agent.iteration'),
    data: z.object({
      agentId: z.string(),
      iteration: z.number().int().positive(),
      runId: z.string(),
    }),
    ts: TimestampSchema,
  }),
  z.object({
    type: z.literal('event'),
    event: z.literal('alert.created'),
    data: AlertCreatedEventSchema,
    ts: TimestampSchema,
  }),
  z.object({
    type: z.literal('event'),
    event: z.literal('alert.read'),
    data: AlertReadEventSchema,
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
