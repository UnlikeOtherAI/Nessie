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
import type { RunContext } from './types.js'

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
    status: 'idle' | 'thinking' | 'executing' | 'error'
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
  },
): Promise<void> => {
  await realtimeTransport.publishWs(buildScopes(context), {
    data: {
      agentId: input.authoredByOwner ? undefined : parseAgentId(context.agent.id),
      channelId: parseChannelId(context.channel.id),
      contentPreview: input.content.slice(0, 200),
      messageId: input.messageId,
      role: input.role,
      threadId: parseThreadId(context.run.threadId),
    },
    event: 'message.new',
  })
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
