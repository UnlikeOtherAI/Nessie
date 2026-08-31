import { applyReplyBookkeeping, type PgRealtimeTransport } from '@nessie/runtime'
import { parseAgentId, parseChannelId, parseThreadId } from '@nessie/schemas'
import type { PrismaClient } from '@prisma/client'

type OrchestrationNoticeDeps = {
  prisma: PrismaClient
  realtimeTransport: PgRealtimeTransport
}

/**
 * Writes the one visible outcome for a decision that could not yield a run.
 * The marker suppresses ordinary at-least-once redelivery before the notice
 * write; an engagement decision must not leave repeated refusals in a person's
 * thread.
 */
export const postOrchestrationNotice = async (
  deps: OrchestrationNoticeDeps,
  input: {
    agentId: string
    channelId: string
    content: string
    kind: 'budget_blocked' | 'credits_exhausted'
    replyRootMessageId?: string
    threadId: string
    triggerMessageId: string
  },
): Promise<void> => {
  const existing = await deps.prisma.message.findFirst({
    where: {
      agentId: input.agentId,
      threadId: input.threadId,
      metadata: {
        path: ['orchestrationNotice', 'triggerMessageId'],
        equals: input.triggerMessageId,
      },
    },
    select: { id: true },
  })
  if (existing) return

  const notice = await deps.prisma.message.create({
    data: {
      agentId: input.agentId,
      content: input.content,
      metadata: {
        orchestrationNotice: {
          kind: input.kind,
          triggerMessageId: input.triggerMessageId,
        },
      },
      role: 'assistant',
      threadId: input.threadId,
      ...(input.replyRootMessageId
        ? { rootMessageId: input.replyRootMessageId }
        : {}),
    },
  })
  const reply = input.replyRootMessageId
    ? await applyReplyBookkeeping(deps.prisma, {
      authorId: input.agentId,
      replyCreatedAt: notice.createdAt,
      rootMessageId: input.replyRootMessageId,
    })
    : undefined
  const scopes = [{
    channelId: parseChannelId(input.channelId),
    kind: 'channel' as const,
  }]

  if (reply && input.replyRootMessageId) {
    await deps.realtimeTransport.publishWs(scopes, {
      data: {
        agentId: parseAgentId(input.agentId),
        channelId: input.channelId,
        contentPreview: notice.content.slice(0, 200),
        messageId: notice.id,
        role: 'assistant',
        rootMessageId: input.replyRootMessageId,
        threadId: parseThreadId(input.threadId),
      },
      event: 'message.reply',
    })
    await deps.realtimeTransport.publishWs(scopes, {
      data: {
        channelId: input.channelId,
        lastReplyAt: reply.lastReplyAt?.toISOString(),
        replyCount: reply.replyCount,
        replyParticipantIds: reply.replyParticipantIds,
        rootMessageId: input.replyRootMessageId,
        threadId: parseThreadId(input.threadId),
      },
      event: 'message.reply.meta',
    })
    return
  }

  await deps.realtimeTransport.publishWs(scopes, {
    data: {
      agentId: parseAgentId(input.agentId),
      channelId: input.channelId,
      contentPreview: notice.content.slice(0, 200),
      messageId: notice.id,
      role: 'assistant',
      threadId: parseThreadId(input.threadId),
    },
    event: 'message.new',
  })
}
