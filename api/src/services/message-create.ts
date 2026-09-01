import { Prisma } from '@prisma/client'
import type { PrismaClient } from '@prisma/client'
import {
  applyReplyBookkeeping,
  createMentionUserAlerts,
  followReplyThread,
  mentionedAgentIdsFromContent,
  resolveMessageMentions,
  type ReplyRootMetadata,
} from '@nessie/runtime'
import { buildAgentVisibilityWhere } from '@nessie/workspace-admin'

import type { PersonalAssistantPresenceMention } from '../contracts/messaging.js'
import { messageInclude, type MessageWithReactions } from './messages.js'

// ─── Message creation (top-level posts + reply-thread replies) ─────────────

// Placeholder body for the "Also send to #channel" copy of an attachment-only
// reply (the copy never carries the attachments themselves).
const ATTACHMENT_ONLY_BROADCAST_CONTENT = 'Shared an attachment'

export type ChannelAgent = {
  id: string
  name: string
  // Present only for a PA binding placed by this member. It turns the
  // organization-singleton PA into a distinct orchestration candidate.
  principalUserId?: string
  role: string
  systemPrompt: string | null
}

export type CreateThreadMessageResult =
  | {
      kind: 'created'
      message: MessageWithReactions
      channelAgents: ChannelAgent[]
      // Direct @mentions (excluding the author) that received a durable alert.
      alertedUserIds: string[]
      // Agents @mentioned in the message that are not members of the channel.
      // They are NOT dispatched; the client offers to invite them.
      pendingAgentInvites: { id: string; name: string }[]
      // Structured PA-presence mentions retained from the validated message.
      agentMentions?: PersonalAssistantPresenceMention[]
      // Set when the message is a reply: the root id plus its post-bookkeeping
      // metadata, so the route can publish `message.reply.meta` without a
      // re-read.
      replyRoot?: { rootMessageId: string; metadata: ReplyRootMetadata }
      // Slack-parity "Also send to #channel": the top-level copy of a reply.
      broadcastMessage?: MessageWithReactions
    }
  | {
      kind: 'thread_not_found'
    }
  | {
      // rootMessageId did not reference a top-level message in this thread.
      kind: 'invalid_root'
    }
  | {
      // A PA mention was not the exact presence currently bound to this
      // channel. Never treat client-provided ids as an authority.
      kind: 'invalid_agent_mention'
    }

export const createThreadMessage = async (
  prisma: PrismaClient,
  input: {
    content: string
    threadId: string
    userId: string
    rootMessageId?: string
    alsoSendToChannel?: boolean
    agentMentions?: PersonalAssistantPresenceMention[]
  },
): Promise<CreateThreadMessageResult> => {
  const thread = await prisma.thread.findUnique({
    where: { id: input.threadId },
    select: {
      channel: {
        select: {
          agentBindings: {
            include: {
              agent: {
                select: {
                  agentKind: true,
                  id: true,
                  name: true,
                  role: true,
                  systemPrompt: true,
                },
              },
            },
            orderBy: { createdAt: 'asc' },
          },
          members: {
            select: {
              user: { select: { id: true, displayName: true } },
            },
          },
          id: true,
          organizationId: true,
          systemChannelType: true,
        },
      },
    },
  })

  if (!thread) {
    return { kind: 'thread_not_found' }
  }

  // Structured PA mentions are valid only for the exact binding that is live
  // in this channel right now. This is deliberately before the message write:
  // a forged/stale presence must neither persist nor enter orchestration.
  const agentMentions = [...new Map(
    (input.agentMentions ?? []).map((mention) => [
      `${mention.agentId}:${mention.principalUserId}`,
      mention,
    ]),
  ).values()]
  const validPresenceMentionKeys = new Set(
    thread.channel.agentBindings.flatMap((binding) =>
      binding.principalUserId && binding.agent.agentKind === 'personal_assistant'
        ? [`${binding.agent.id}:${binding.principalUserId}`]
        : []),
  )
  if (agentMentions.some(
    (mention) => !validPresenceMentionKeys.has(`${mention.agentId}:${mention.principalUserId}`),
  )) {
    return { kind: 'invalid_agent_mention' }
  }

  // Resolve human + broadcast mentions on the inbound content. Agent mentions
  // are resolved below for engagement; here we record every mention class on
  // message.metadata.mentions so clients can highlight/notify deterministically.
  const mentions = resolveMessageMentions(input.content, {
    members: thread.channel.members.map((m) => ({
      userId: m.user.id,
      displayName: m.user.displayName,
    })),
  })

  let message: MessageWithReactions
  let alertedUserIds: string[] = []
  let replyRoot: { rootMessageId: string; metadata: ReplyRootMetadata } | undefined

  if (input.rootMessageId) {
    const rootMessageId = input.rootMessageId
    // Reply path (#233): validate the root, create the reply, and apply the
    // root bookkeeping + follows in one transaction so concurrent replies
    // cannot lose counts and a failed validation creates nothing. Replies to
    // replies attach to the same root, so a root that is itself a reply is
    // rejected (one level deep). Tombstoned roots reject new replies.
    const txResult = await prisma.$transaction(async (tx) => {
      const root = await tx.message.findUnique({
        where: { id: rootMessageId },
        select: { id: true, threadId: true, rootMessageId: true, deletedAt: true },
      })
      if (
        !root
        || root.threadId !== input.threadId
        || root.rootMessageId !== null
        || root.deletedAt !== null
      ) {
        return { kind: 'invalid_root' as const }
      }
      const created = await tx.message.create({
        data: {
          threadId: input.threadId,
          userId: input.userId,
          role: 'user',
          content: input.content,
          rootMessageId,
          metadata: { mentions } as Prisma.InputJsonValue,
        },
        include: messageInclude,
      })
      const metadata = await applyReplyBookkeeping(tx, {
        rootMessageId,
        replyCreatedAt: created.createdAt,
        authorId: input.userId,
      })
      // Participate-to-follow: the reply author and every mentioned user
      // follow the reply thread.
      await followReplyThread(tx, {
        rootMessageId,
        userIds: [input.userId, ...mentions.userIds],
      })
      const alerted = await createMentionUserAlerts(tx, {
        organizationId: thread.channel.organizationId,
        messageId: created.id,
        threadId: input.threadId,
        channelId: thread.channel.id,
        actorUserId: input.userId,
        mentionedUserIds: mentions.userIds,
      })
      return { kind: 'created' as const, message: created, metadata, alertedUserIds: alerted }
    })
    if (txResult.kind === 'invalid_root') {
      return { kind: 'invalid_root' }
    }
    message = txResult.message
    alertedUserIds = txResult.alertedUserIds
    replyRoot = { rootMessageId, metadata: txResult.metadata }
  } else {
    // Top-level posts atomically establish a follow and durable mention alerts.
    const txResult = await prisma.$transaction(async (tx) => {
      const created = await tx.message.create({
        data: {
          threadId: input.threadId,
          userId: input.userId,
          role: 'user',
          content: input.content,
          metadata: { mentions } as Prisma.InputJsonValue,
        },
        include: messageInclude,
      })
      await followReplyThread(tx, {
        rootMessageId: created.id,
        // A direct mention is an explicit invitation into this reply
        // conversation just as it is for a reply. This keeps the durable
        // Threads inbox independent from whether its alert is later read.
        userIds: [input.userId, ...mentions.userIds],
      })
      const alerted = await createMentionUserAlerts(tx, {
        organizationId: thread.channel.organizationId,
        messageId: created.id,
        threadId: input.threadId,
        channelId: thread.channel.id,
        actorUserId: input.userId,
        mentionedUserIds: mentions.userIds,
      })
      return { message: created, alertedUserIds: alerted }
    })
    message = txResult.message
    alertedUserIds = txResult.alertedUserIds
  }

  const channelAgents: ChannelAgent[] = thread.channel.agentBindings.map((b) => ({
    id: b.agent.id,
    name: b.agent.name,
    ...(b.principalUserId ? { principalUserId: b.principalUserId } : {}),
    role: b.agent.role,
    systemPrompt: b.agent.systemPrompt,
  }))
  const resolvedChannelAgents =
    thread.channel.systemChannelType === 'personal_assistant'
      ? channelAgents.slice(0, 1)
      : channelAgents
  const ordinaryChannelAgents = resolvedChannelAgents.filter(
    (agent) => agent.principalUserId === undefined,
  )

  // An @mention of an agent that is NOT a member (bound) of this channel does
  // not silently pull it in: only members participate. Such mentions are
  // surfaced as pending invites so the client can offer to add the agent to the
  // channel (after which it participates like any other member). Agent names can
  // contain spaces, so we match each candidate name against the content with the
  // same escape rule the orchestrator uses rather than splitting on whitespace.
  const pendingAgentInvites: { id: string; name: string }[] = []
  if (input.content.includes('@')) {
    const boundIds = new Set(resolvedChannelAgents.map((a) => a.id))
    const candidates = await prisma.agent.findMany({
      where: {
        AND: [buildAgentVisibilityWhere({
          organizationId: thread.channel.organizationId,
          userId: input.userId,
        })],
        agentKind: 'shared',
        id: { notIn: [...boundIds] },
        organizationId: thread.channel.organizationId,
        systemManaged: false,
      },
      select: { id: true, name: true },
    })

    for (const agent of candidates) {
      const escaped = agent.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      const mentionRe = new RegExp(`@${escaped}(?:\\s|$|[^\\w])`, 'i')
      if (mentionRe.test(input.content)) {
        pendingAgentInvites.push({ id: agent.id, name: agent.name })
      }
    }
  }

  // Record which agents the message @mentioned (bound or freshly resolved).
  // Only persist a metadata update when there are agent mentions to add —
  // human/broadcast mentions were already written at create time.
  const mentionedAgentIds = mentionedAgentIdsFromContent(
    input.content,
    ordinaryChannelAgents,
  )
  let persistedMessage = message
  const mergedMentions = {
    ...mentions,
    agentIds: mentionedAgentIds,
    ...(agentMentions.length > 0 ? { agentMentions } : {}),
  }
  if (mentionedAgentIds.length > 0 || agentMentions.length > 0) {
    persistedMessage = await prisma.message.update({
      where: { id: message.id },
      data: { metadata: { mentions: mergedMentions } as Prisma.InputJsonValue },
      include: messageInclude,
    })
  }

  // "Also send to #channel" (#233): an informational top-level copy of the
  // reply pointing back at the reply thread. No bookkeeping, no auto-follow;
  // the route publishes a plain `message.new` for it and skips orchestration.
  let broadcastMessage: MessageWithReactions | undefined
  if (input.rootMessageId && input.alsoSendToChannel) {
    broadcastMessage = await prisma.message.create({
      data: {
        threadId: input.threadId,
        userId: input.userId,
        role: 'user',
        // Copies carry no attachments, so an attachment-only reply would render
        // as an empty bubble in the channel — say what it points at instead.
        content:
          input.content.trim().length > 0 ? input.content : ATTACHMENT_ONLY_BROADCAST_CONTENT,
        metadata: {
          mentions: mergedMentions,
          replyBroadcast: { rootMessageId: input.rootMessageId },
        } as Prisma.InputJsonValue,
      },
      include: messageInclude,
    })
  }

  return {
    kind: 'created',
    message: persistedMessage,
    channelAgents: resolvedChannelAgents,
    alertedUserIds,
    pendingAgentInvites,
    ...(agentMentions.length > 0 ? { agentMentions } : {}),
    ...(replyRoot ? { replyRoot } : {}),
    ...(broadcastMessage ? { broadcastMessage } : {}),
  }
}
