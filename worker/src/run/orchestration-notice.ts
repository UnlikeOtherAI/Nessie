import {
  applyReplyBookkeeping,
  publishMessageEnvelope,
  type PgRealtimeTransport,
} from '@nessie/runtime'
import { parseChannelId, parseThreadId } from '@nessie/schemas'
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
    principalUserId?: string
    replyRootMessageId?: string
    threadId: string
    triggerMessageId: string
  },
): Promise<void> => {
  const existing = await deps.prisma.message.findFirst({
    where: {
      agentId: input.agentId,
      onBehalfOfUserId: input.principalUserId ?? null,
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
      ...(input.principalUserId
        ? { onBehalfOfUserId: input.principalUserId }
        : {}),
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

  // One envelope for both shapes: a notice posted under a root announces as
  // `message.reply`, a top-level one as `message.new`.
  await publishMessageEnvelope(deps.realtimeTransport, scopes, {
    channelId: input.channelId,
    message: {
      agentId: input.agentId,
      content: notice.content,
      id: notice.id,
      role: 'assistant',
    },
    ...(reply && input.replyRootMessageId
      ? { rootMessageId: input.replyRootMessageId }
      : {}),
    threadId: input.threadId,
  })
  if (reply && input.replyRootMessageId) {
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
  }
}
