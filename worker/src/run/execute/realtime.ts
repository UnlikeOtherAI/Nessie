import type { PgRealtimeTransport } from '@nessie/runtime'
import {
  parseAgentId,
  parseChannelId,
  parseRunId,
  parseTaskId,
  parseThreadId,
  type RunStatus,
  type TaskStatus,
  type WsScope,
} from '@nessie/schemas'
import { buildScopes } from './scopes.js'
import type { ReplyPlacement, RunContext } from './types.js'
export { publishAgentTodoUpdated } from '@nessie/team-admin'

export const publishRunUpdated = async (
  realtimeTransport: PgRealtimeTransport,
  context: RunContext,
  status: RunStatus,
): Promise<void> => {
  await realtimeTransport.publishWs(buildScopes(context), {
    data: {
      agentId: parseAgentId(context.agent.id),
      runId: parseRunId(context.run.id),
      status,
    },
    event: 'run.updated',
  })
}

export const publishAgentStatus = async (
  realtimeTransport: PgRealtimeTransport,
  context: RunContext,
  input: {
    status: | 'idle'
    | 'thinking'
    | 'executing'
    | 'waiting_approval'
    | 'waiting_input'
    | 'error'
    currentRunId?: string
    currentToolName?: string
    currentToolStartedAt?: string
  },
): Promise<void> => {
  await realtimeTransport.publishWs(buildScopes(context), {
    data: {
      agentId: parseAgentId(context.agent.id),
      status: input.status,
      since: new Date().toISOString(),
      currentRunId: input.currentRunId ? parseRunId(input.currentRunId) : undefined,
      currentToolName: input.currentToolName,
      currentToolStartedAt: input.currentToolStartedAt,
    },
    event: 'agent.status',
  })
}

// Publishes the message-created WS event for a run-authored message. With
// reply-thread placement (#233) set, publishes `message.reply` instead.
export const publishMessageCreated = async (
  realtimeTransport: PgRealtimeTransport,
  context: RunContext,
  input: {
    content: string
    messageId: string
    role: 'assistant' | 'system' | 'user'
    // A delegated owner-authored post (the personal assistant acting for its
    // owner) carries no agent author, mirroring a human-authored message.
    authoredByOwner?: boolean
    // When present, the message is a reply: publish `message.reply` INSTEAD of
    // `message.new`, followed by the root's updated `message.reply.meta`.
    reply?: ReplyPlacement
    /**
     * True when the message carries a disclosure basis. WS scopes are channel-
     * and organization-wide (`buildScopes`), so a content preview here reaches
     * every connected member regardless of entitlement — a leak no read-side
     * predicate can close, because it happens on the wire. A restricted message
     * therefore publishes **content-free**: entitled clients refetch through the
     * gated list endpoint, and everyone else learns only that something arrived.
     */
    restricted?: boolean
  },
): Promise<void> => {
  const scopes = buildScopes(context)
  const { reply } = input
  await realtimeTransport.publishWs(scopes, {
    data: {
      agentId: input.authoredByOwner ? undefined : parseAgentId(context.agent.id),
      channelId: parseChannelId(context.channel.id),
      ...(input.restricted
        ? { restricted: true }
        : { contentPreview: input.content.slice(0, 200) }),
      messageId: input.messageId,
      role: input.role,
      threadId: parseThreadId(context.run.threadId),
      ...(reply ? { rootMessageId: reply.rootMessageId } : {}),
    },
    event: reply ? 'message.reply' : 'message.new',
  })
  if (reply) {
    await realtimeTransport.publishWs(scopes, {
      data: {
        channelId: parseChannelId(context.channel.id),
        threadId: parseThreadId(context.run.threadId),
        rootMessageId: reply.rootMessageId,
        replyCount: reply.meta.replyCount,
        lastReplyAt: reply.meta.lastReplyAt?.toISOString(),
        replyParticipantIds: reply.meta.replyParticipantIds,
      },
      event: 'message.reply.meta',
    })
  }
}

export const publishTaskUpdated = async (
  realtimeTransport: PgRealtimeTransport,
  scopes: WsScope[],
  taskId: string,
  status: TaskStatus,
): Promise<void> => {
  await realtimeTransport.publishWs(scopes, {
    data: {
      taskId: parseTaskId(taskId),
      status,
    },
    event: 'task.updated',
  })
}

/**
 * A message changed in place (the rolling watch status). Distinct from
 * `message.created`: clients refresh the open thread but must not treat it as
 * new activity — no unread bump, no notification.
 */
export const publishMessageUpdated = async (
  transport: PgRealtimeTransport,
  context: RunContext,
  input: {
    content: string
    editedAt: Date
    messageId: string
    /** See `publishMessageCreated`: a restricted edit publishes content-free. */
    restricted?: boolean
  },
): Promise<void> => {
  await transport.publishWs(buildScopes(context), {
    data: {
      ...(input.restricted
        ? { restricted: true as const }
        : { contentPreview: input.content.slice(0, 200) }),
      editedAt: input.editedAt.toISOString(),
      messageId: input.messageId,
      threadId: parseThreadId(context.run.threadId),
    },
    event: 'message.updated',
  })
}
