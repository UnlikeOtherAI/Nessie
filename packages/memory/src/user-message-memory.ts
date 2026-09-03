import type { CaptureConfig, CapturedThought } from './capture.js'
import { captureThought } from './capture.js'

export type UserMessageMemoryOrigin =
  | 'personal_assistant_dm'
  | 'user_authored_team_message'
  | 'user_conversation_summary'

export type CaptureUserMessageMemoryInput = {
  channelId: string
  content: string
  memoryOrigin: UserMessageMemoryOrigin
  messageId: string
  organizationId: string
  sourceAudience: string
  threadId: string
  userId: string
  projectId?: string
  teamId?: string
  sessionId?: string
  taskId?: string
  runId?: string
  agentId?: string
  agentKind?: 'personal_assistant' | 'shared'
  actorId?: string
  actorType?: 'user' | 'agent' | 'service' | 'system'
  requestId?: string
  correlationId?: string
  systemComponent?: string
}

export const captureUserMessageMemory = async (
  input: CaptureUserMessageMemoryInput,
  config: CaptureConfig,
): Promise<CapturedThought> =>
  captureThought(
    {
      audienceId: input.userId,
      audienceType: 'user',
      channelId: input.channelId,
      content: input.content,
      metadata: {
        memory_origin: input.memoryOrigin,
        source_audience: input.sourceAudience,
        source_channel_id: input.channelId,
        source_message_id: input.messageId,
        source_thread_id: input.threadId,
      },
      organizationId: input.organizationId,
      projectId: input.projectId,
      teamId: input.teamId,
      ownerId: input.userId,
      ownerType: 'user',
      threadId: input.threadId,
      userId: input.userId,
      sessionId: input.sessionId,
      taskId: input.taskId,
      runId: input.runId,
      agentId: input.agentId,
      agentKind: input.agentKind,
      actorId: input.actorId,
      actorType: input.actorType,
      requestId: input.requestId,
      correlationId: input.correlationId,
      systemComponent: input.systemComponent,
      visibility: 'private',
    },
    config,
  )
