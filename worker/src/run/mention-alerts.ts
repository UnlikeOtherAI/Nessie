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
type AlertDeps = {
  prisma: PrismaClient
  realtimeTransport: Pick<PgRealtimeTransport, 'publishWs'>
}

type AlertTarget = {
  organizationId: string
  channelId: string
  threadId: string
  messageId: string
  messageCreatedAt: Date
  actorUserId?: string | null
  actorAgentId?: string | null
  scopes: WsScope[]
}

/**
 * Durable `mention` alerts for an explicit recipient list, plus reply-thread
 * follow and the per-recipient `alert.created` fan-out.
 *
 * Extracted so two callers share one implementation: mentions parsed out of a
 * message's content, and an agent card naming exactly who it is asking. The
 * card path must not go through content parsing — who may answer a card is a
 * structural fact the agent stated, never something to rediscover by looking
 * for an "@" in prose.
 *
 * Best-effort throughout: the message already exists when this runs, so a
 * failure here is logged and swallowed rather than breaking delivery.
 */
const alertRecipients = async (
  deps: AlertDeps,
  target: AlertTarget,
  recipientUserIds: string[],
): Promise<void> => {
  let alertedUserIds: string[]
  try {
    alertedUserIds = await createMentionUserAlerts(deps.prisma, {
      organizationId: target.organizationId,
      messageId: target.messageId,
      threadId: target.threadId,
      channelId: target.channelId,
      actorUserId: target.actorUserId ?? null,
      actorAgentId: target.actorAgentId ?? null,
      mentionedUserIds: recipientUserIds,
    })
    // Agent replies use the same durable participation model as human
    // messages. Alert state is separate attention state, never the source of
    // truth for whether a conversation belongs in Threads.
    const message = await deps.prisma.message.findUnique({
      where: { id: target.messageId },
      select: { rootMessageId: true },
    })
    if (message) {
      await followReplyThread(deps.prisma, {
        rootMessageId: message.rootMessageId ?? target.messageId,
        userIds: recipientUserIds,
      })
    }
  } catch (error) {
    console.error(
      '[mention-alerts] failed to persist alerts for message',
      target.messageId,
      error,
    )
    return
  }

  for (const userId of alertedUserIds) {
    try {
      await deps.realtimeTransport.publishWs(target.scopes, {
        data: {
          userId: parseUserId(userId),
          kind: 'mention' as const,
          messageId: target.messageId,
          threadId: parseThreadId(target.threadId),
          channelId: parseChannelId(target.channelId),
          actorUserId: target.actorUserId ? parseUserId(target.actorUserId) : undefined,
          actorAgentId: target.actorAgentId ? parseAgentId(target.actorAgentId) : undefined,
          createdAt: target.messageCreatedAt.toISOString(),
        },
        event: 'alert.created',
      })
    } catch (error) {
      console.error(
        '[mention-alerts] failed to publish alert.created for message',
        target.messageId,
        error,
      )
    }
  }
}

export const createMessageMentionAlerts = async (
  deps: AlertDeps,
  input: AlertTarget & { content: string },
): Promise<void> => {
  if (!input.content.includes('@')) {
    return
  }

  let mentionedUserIds: string[]
  try {
    const members = await deps.prisma.channelMember.findMany({
      where: { channelId: input.channelId },
      select: { user: { select: { id: true, displayName: true } } },
    })
    mentionedUserIds = resolveMessageMentions(input.content, {
      members: members.map((member) => ({
        userId: member.user.id,
        displayName: member.user.displayName,
      })),
    }).userIds
  } catch (error) {
    console.error(
      '[mention-alerts] failed to resolve mentions for message',
      input.messageId,
      error,
    )
    return
  }
  if (mentionedUserIds.length === 0) return

  await alertRecipients(deps, input, mentionedUserIds)
}

/**
 * The people an agent card names are being asked for something, so they get
 * the ordinary mention bell and the mention-framed push — no new alert kind,
 * no new surface. A thread-wide card names nobody and alerts nobody: it is
 * read like any other message in the room.
 */
export const alertCardRespondents = async (
  deps: AlertDeps,
  input: AlertTarget & { recipientUserIds: string[] },
): Promise<void> => {
  if (input.recipientUserIds.length === 0) return
  await alertRecipients(deps, input, input.recipientUserIds)
}
