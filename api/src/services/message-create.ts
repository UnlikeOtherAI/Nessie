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
import type { AgentMention } from '@nessie/schemas'
import { buildAgentVisibilityWhere } from '@nessie/team-admin'

import { messageInclude, type MessageWithReactions } from './message-read-model.js'

// ─── Message creation: a person's send ─────────────────────────────────────
//
// The one door for a message a *person* posts, with everything that makes such
// a send real: the idempotency key, structured-mention validation, durable
// mention alerts, participate-to-follow and the "also send to #channel" copy.
// Messages the server authors on someone's behalf go through
// `system-authored-message.ts`, which states which of these it skips and why.

// Placeholder body for the "Also send to #channel" copy of an attachment-only
// reply (the copy never carries the attachments themselves).
const ATTACHMENT_ONLY_BROADCAST_CONTENT = 'Shared an attachment'

// The message a previous attempt with this idempotency key created, if any.
const findMessageByClientKey = async (
  prisma: PrismaClient,
  threadId: string,
  clientMessageId: string,
): Promise<MessageWithReactions | null> =>
  prisma.message.findFirst({
    where: { threadId, clientMessageId },
    include: messageInclude,
  })

// Two attempts of the same send can race past the pre-check; the unique index
// `(thread_id, client_message_id)` then rejects the loser, and the losing
// attempt replays the winner's row rather than surfacing a conflict a person
// would read as "your message failed".
const isDuplicateClientKey = (error: unknown): boolean =>
  error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002'

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
      // The exact message this thread already holds for the caller's
      // idempotency key. A retried send lands here instead of creating a
      // second copy; the route replays the original response shape.
      kind: 'replayed'
      message: MessageWithReactions
    }
  | {
      kind: 'created'
      message: MessageWithReactions
      channelAgents: ChannelAgent[]
      // Direct @mentions (excluding the author) that received a durable alert.
      alertedUserIds: string[]
      // Agents @mentioned in the message that are not members of the channel.
      // They are NOT dispatched; the client offers to invite them.
      pendingAgentInvites: { id: string; name: string }[]
      // Structured agent mentions retained from the validated message.
      agentMentions?: AgentMention[]
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
      // A mention was not an agent identity the sender may address here.
      // Never treat client-provided ids as an authority.
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
    agentMentions?: AgentMention[]
    clientMessageId?: string
  },
): Promise<CreateThreadMessageResult> => {
  // Idempotent send: the same key in the same thread is the same message. The
  // pre-check answers the common retry without a write; the unique index
  // `(thread_id, client_message_id)` is what makes two simultaneous attempts
  // resolve to one row, and the catch below turns that race into a replay.
  if (input.clientMessageId) {
    const existing = await findMessageByClientKey(
      prisma,
      input.threadId,
      input.clientMessageId,
    )
    if (existing) {
      return { kind: 'replayed', message: existing }
    }
  }

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

  // Structured mentions are identities, not hints. Validate every one before
  // the message write: a forged/stale id must neither persist nor enter
  // orchestration. An ordinary bound agent is already proven by the channel;
  // an unbound agent must pass the same visibility gate as the invite
  // flow. PA presences additionally require their exact live owner binding.
  const agentMentions = [...new Map(
    (input.agentMentions ?? []).map((mention) => [
      `${mention.agentId}:${mention.principalUserId ?? ''}`,
      mention,
    ]),
  ).values()]
  const validPresenceMentionKeys = new Set(
    thread.channel.agentBindings.flatMap((binding) =>
      binding.principalUserId && binding.agent.agentKind === 'personal_assistant'
        ? [`${binding.agent.id}:${binding.principalUserId}`]
        : []),
  )
  const presenceMentions = agentMentions.filter(
    (mention): mention is AgentMention & { principalUserId: string } =>
      mention.principalUserId !== undefined,
  )
  if (presenceMentions.some(
    (mention) => !validPresenceMentionKeys.has(`${mention.agentId}:${mention.principalUserId}`),
  )) {
    return { kind: 'invalid_agent_mention' }
  }
  const ordinaryMentionIds = [...new Set(
    agentMentions
      .filter((mention) => mention.principalUserId === undefined)
      .map((mention) => mention.agentId),
  )]
  const boundOrdinaryAgents = thread.channel.agentBindings.flatMap((binding) =>
    !binding.principalUserId && binding.agent.agentKind !== 'personal_assistant'
      ? [{ id: binding.agent.id, name: binding.agent.name }]
      : [],
  )
  const boundOrdinaryIds = new Set(boundOrdinaryAgents.map((agent) => agent.id))
  const unboundMentionIds = ordinaryMentionIds.filter((id) => !boundOrdinaryIds.has(id))
  if (thread.channel.systemChannelType && unboundMentionIds.length > 0) {
    return { kind: 'invalid_agent_mention' }
  }
  const unboundMentionAgents = unboundMentionIds.length > 0
    ? await prisma.agent.findMany({
        where: {
          AND: [buildAgentVisibilityWhere({
            organizationId: thread.channel.organizationId,
            userId: input.userId,
          })],
          agentKind: 'shared',
          executionMode: { not: 'external_mcp' },
          id: { in: unboundMentionIds },
          organizationId: thread.channel.organizationId,
        },
        select: { id: true, name: true },
      })
    : []
  if (unboundMentionAgents.length !== unboundMentionIds.length) {
    return { kind: 'invalid_agent_mention' }
  }
  const structuredOrdinaryAgents = new Map(
    [...boundOrdinaryAgents, ...unboundMentionAgents].map((agent) => [agent.id, agent]),
  )

  // Resolve human + broadcast mentions on the inbound content. Agent mentions
  // are resolved below for engagement; here we record every mention class on
  // message.metadata.mentions so clients can highlight/notify deterministically.
  const mentions = resolveMessageMentions(input.content, {
    members: thread.channel.members.map((m) => ({
      userId: m.user.id,
      displayName: m.user.displayName,
    })),
  })

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

  // Which agents the message @mentioned (bound or freshly resolved), folded
  // into the mentions the row is created with. This is resolved *before* the
  // transaction — every input is already known — because a message whose
  // stored mentions omit its agent mentions is indistinguishable from one that
  // had none, and that is what clients highlight and orchestration replays.
  const mentionedAgentIds = agentMentions.length > 0
    ? ordinaryMentionIds
    : mentionedAgentIdsFromContent(input.content, ordinaryChannelAgents)
  const mergedMentions = {
    ...mentions,
    agentIds: mentionedAgentIds,
    ...(agentMentions.length > 0 ? { agentMentions } : {}),
  }
  const messageMetadata = { mentions: mergedMentions } as Prisma.InputJsonValue

  let message: MessageWithReactions
  let alertedUserIds: string[] = []
  let broadcastMessage: MessageWithReactions | undefined
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
          ...(input.clientMessageId ? { clientMessageId: input.clientMessageId } : {}),
          metadata: messageMetadata,
        },
        include: messageInclude,
      })
      // "Also send to #channel" (#233): an informational top-level copy of the
      // reply pointing back at the reply thread. No bookkeeping, no auto-follow
      // and no orchestration — but it is part of the same send, so it commits
      // with it rather than becoming an orphan of a half-applied post.
      const broadcast = input.alsoSendToChannel
        ? await tx.message.create({
          data: {
            threadId: input.threadId,
            userId: input.userId,
            role: 'user',
            // Copies carry no attachments, so an attachment-only reply would
            // render as an empty bubble in the channel — say what it points at.
            content:
              input.content.trim().length > 0
                ? input.content
                : ATTACHMENT_ONLY_BROADCAST_CONTENT,
            metadata: {
              mentions: mergedMentions,
              replyBroadcast: { rootMessageId },
            } as Prisma.InputJsonValue,
          },
          include: messageInclude,
        })
        : undefined
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
      return {
        alertedUserIds: alerted,
        broadcast,
        kind: 'created' as const,
        message: created,
        metadata,
      }
    }).catch(async (error: unknown) => {
      if (input.clientMessageId && isDuplicateClientKey(error)) {
        const won = await findMessageByClientKey(prisma, input.threadId, input.clientMessageId)
        if (won) return { kind: 'raced' as const, message: won }
      }
      throw error
    })
    if (txResult.kind === 'invalid_root') {
      return { kind: 'invalid_root' }
    }
    if (txResult.kind === 'raced') {
      return { kind: 'replayed', message: txResult.message }
    }
    message = txResult.message
    alertedUserIds = txResult.alertedUserIds
    broadcastMessage = txResult.broadcast
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
          ...(input.clientMessageId ? { clientMessageId: input.clientMessageId } : {}),
          metadata: messageMetadata,
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
      return { message: created, alertedUserIds: alerted, raced: null }
    }).catch(async (error: unknown) => {
      if (input.clientMessageId && isDuplicateClientKey(error)) {
        const won = await findMessageByClientKey(prisma, input.threadId, input.clientMessageId)
        if (won) return { alertedUserIds: [] as string[], message: won, raced: won }
      }
      throw error
    })
    if (txResult.raced) {
      return { kind: 'replayed', message: txResult.raced }
    }
    message = txResult.message
    alertedUserIds = txResult.alertedUserIds
  }

  // An @mention of an agent that is NOT a member (bound) of this channel does
  // not silently pull it in: only members participate. Such mentions are
  // surfaced as pending invites so the client can offer to add the agent to the
  // channel (after which it participates like any other member). Agent names can
  // contain spaces, so we match each candidate name against the content with the
  // same escape rule the orchestrator uses rather than splitting on whitespace.
  const pendingAgentInvites: { id: string; name: string }[] = []
  if (agentMentions.length > 0) {
    for (const agentId of ordinaryMentionIds) {
      if (boundOrdinaryIds.has(agentId)) continue
      const agent = structuredOrdinaryAgents.get(agentId)
      if (agent) pendingAgentInvites.push(agent)
    }
  } else if (input.content.includes('@')) {
    const boundIds = new Set(resolvedChannelAgents.map((a) => a.id))
    const candidates = await prisma.agent.findMany({
      where: {
        AND: [buildAgentVisibilityWhere({
          organizationId: thread.channel.organizationId,
          userId: input.userId,
        })],
        // `agentKind: 'shared'` is what excludes the Personal Assistant, whose
        // presence is a different act with a different key. `systemManaged` is
        // deliberately NOT filtered: an app-provided shared agent binds through
        // the ordinary chokepoint, so mentioning one must offer the same invite
        // every other agent gets. `executionMode` excludes external-agent
        // products, which `bindAgentToChannel` refuses.
        agentKind: 'shared',
        executionMode: { not: 'external_mcp' },
        id: { notIn: [...boundIds] },
        organizationId: thread.channel.organizationId,
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

  return {
    kind: 'created',
    message,
    channelAgents: resolvedChannelAgents,
    alertedUserIds,
    pendingAgentInvites,
    ...(agentMentions.length > 0 ? { agentMentions } : {}),
    ...(replyRoot ? { replyRoot } : {}),
    ...(broadcastMessage ? { broadcastMessage } : {}),
  }
}
