import type { CaptureConfig, CapturedThought } from './capture.js'
import { captureThought } from './capture.js'

export type UserMessageMemoryOrigin =
  | 'personal_assistant_dm'
  | 'user_authored_workspace_message'
  | 'user_conversation_summary'

type CaptureUserMessageMemoryInput = {
  channelId: string
  content: string
  memoryOrigin: UserMessageMemoryOrigin
  messageId: string
  organizationId: string
  sourceAudience: string
  threadId: string
  userId: string
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
      ownerId: input.userId,
      ownerType: 'user',
      threadId: input.threadId,
      userId: input.userId,
      visibility: 'private',
    },
    config,
  )
