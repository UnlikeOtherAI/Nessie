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
import { NonEmptyStringSchema, TimestampSchema } from './schema-primitives.js'

export type SseEventMap = {
  'stream.start': { runId: RunId; threadId: ThreadId; agentId: AgentId }
  'stream.reasoning': { runId: RunId; content: string }
  'stream.delta': { runId: RunId; content: string }
  'stream.done': {
    runId: RunId
    messageId: string
    agentId?: AgentId
    content?: string
    createdAt?: string
  }
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
    agentId?: AgentId
    authorUserId?: UserId
    channelId?: ChannelId
    messageId: string
    role: MessageRole
    contentPreview: string
    threadId: ThreadId
  }
  // sp-messaging slice: message lifecycle events
  'message.updated': {
    messageId: string
    threadId: ThreadId
    contentPreview: string
    editedAt: string
  }
  'message.deleted': {
    messageId: string
    threadId: ThreadId
    deletedAt: string
  }
  'message.reaction': { messageId: string; agentId?: AgentId; userId?: string; emoji: string }
  'agent.iteration': {
    agentId: string
    iteration: number
    runId: string
  }
}

export const StreamStartEventSchema = z.object({
  agentId: AgentIdSchema,
  runId: RunIdSchema,
  threadId: ThreadIdSchema,
})
export type StreamStartEvent = z.infer<typeof StreamStartEventSchema>
export const StreamDeltaEventSchema = z.object({
  runId: RunIdSchema,
  content: z.string(),
})
export type StreamDeltaEvent = z.infer<typeof StreamDeltaEventSchema>
export const StreamReasoningEventSchema = z.object({
  runId: RunIdSchema,
  content: z.string(),
})
export type StreamReasoningEvent = z.infer<typeof StreamReasoningEventSchema>
export const StreamDoneEventSchema = z.object({
  agentId: AgentIdSchema.optional(),
  content: z.string().optional(),
  createdAt: TimestampSchema.optional(),
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
export const SseEventNameSchema = z.enum([
  'stream.start',
  'stream.reasoning',
  'stream.delta',
  'stream.done',
  'message.reaction',
])

export const SseEventSchema = z.discriminatedUnion('event', [
  z.object({
    event: z.literal('stream.start'),
    data: StreamStartEventSchema,
  }),
  z.object({
    event: z.literal('stream.reasoning'),
    data: StreamReasoningEventSchema,
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
  agentId: AgentIdSchema.optional(),
  authorUserId: UserIdSchema.optional(),
  channelId: ChannelIdSchema.optional(),
  messageId: NonEmptyStringSchema,
  role: MessageRoleSchema,
  contentPreview: z.string(),
  threadId: ThreadIdSchema,
})
export type MessageNewEvent = z.infer<typeof MessageNewEventSchema>
// sp-messaging slice: message lifecycle event schemas
export const MessageUpdatedEventSchema = z.object({
  messageId: NonEmptyStringSchema,
  threadId: ThreadIdSchema,
  contentPreview: z.string(),
  editedAt: TimestampSchema,
})
export type MessageUpdatedEvent = z.infer<typeof MessageUpdatedEventSchema>
export const MessageDeletedEventSchema = z.object({
  messageId: NonEmptyStringSchema,
  threadId: ThreadIdSchema,
  deletedAt: TimestampSchema,
})
export type MessageDeletedEvent = z.infer<typeof MessageDeletedEventSchema>
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
  'message.updated',
  'message.deleted',
  'message.reaction',
  'agent.iteration',
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
    event: z.literal('agent.iteration'),
    data: z.object({
      agentId: z.string(),
      iteration: z.number().int().positive(),
      runId: z.string(),
    }),
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
