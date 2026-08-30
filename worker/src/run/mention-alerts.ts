import type { PrismaClient } from '@prisma/client'
import {
  createMentionUserAlerts,
  followReplyThread,
  resolveMessageMentions,
  type PgRealtimeTransport,
} from '@nessie/runtime'
import {
  parseAgentId,
  parseChannelId,
  parseThreadId,
  parseUserId,
  type WsScope,
} from '@nessie/schemas'

/**
 * Agent-authored mention alerts (#246): an agent (or a personal assistant
 * posting as its owner) who @mentions a user creates the exact same durable
 * `mention` UserAlert rows a human author would, plus the per-recipient
 * `alert.created` realtime fan-out.
 *
 * Fully best-effort: the message is already created when this runs, so a
 * failure here is logged and swallowed — alerts must never break delivery.
 */
export const createMessageMentionAlerts = async (
  deps: {
    prisma: PrismaClient
    realtimeTransport: Pick<PgRealtimeTransport, 'publishWs'>
  },
  input: {
    organizationId: string
    channelId: string
    threadId: string
    messageId: string
    messageCreatedAt: Date
    content: string
    actorUserId?: string | null
    actorAgentId?: string | null
    scopes: WsScope[]
  },
): Promise<void> => {
  if (!input.content.includes('@')) {
    return
  }

  let alertedUserIds: string[]
  try {
    const members = await deps.prisma.channelMember.findMany({
      where: { channelId: input.channelId },
      select: { user: { select: { id: true, displayName: true } } },
    })
    const mentions = resolveMessageMentions(input.content, {
      members: members.map((member) => ({
        userId: member.user.id,
        displayName: member.user.displayName,
      })),
    })
    alertedUserIds = await createMentionUserAlerts(deps.prisma, {
      organizationId: input.organizationId,
      messageId: input.messageId,
      threadId: input.threadId,
      channelId: input.channelId,
      actorUserId: input.actorUserId ?? null,
      actorAgentId: input.actorAgentId ?? null,
      mentionedUserIds: mentions.userIds,
    })
    // Agent replies use the same durable participation model as human
    // messages. Alert state is separate attention state, never the source of
    // truth for whether a conversation belongs in Threads.
    const message = await deps.prisma.message.findUnique({
      where: { id: input.messageId },
      select: { rootMessageId: true },
    })
    if (message) {
      await followReplyThread(deps.prisma, {
        rootMessageId: message.rootMessageId ?? input.messageId,
        userIds: mentions.userIds,
      })
    }
  } catch (error) {
    console.error(
      '[mention-alerts] failed to persist mention alerts for message',
      input.messageId,
      error,
    )
    return
  }

  for (const userId of alertedUserIds) {
    try {
      await deps.realtimeTransport.publishWs(input.scopes, {
        data: {
          userId: parseUserId(userId),
          kind: 'mention' as const,
          messageId: input.messageId,
          threadId: parseThreadId(input.threadId),
          channelId: parseChannelId(input.channelId),
          actorUserId: input.actorUserId ? parseUserId(input.actorUserId) : undefined,
          actorAgentId: input.actorAgentId ? parseAgentId(input.actorAgentId) : undefined,
          createdAt: input.messageCreatedAt.toISOString(),
        },
        event: 'alert.created',
      })
    } catch (error) {
      console.error(
        '[mention-alerts] failed to publish alert.created for message',
        input.messageId,
        error,
      )
    }
  }
}
