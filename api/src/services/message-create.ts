import { Prisma } from '@prisma/client'
import type { PrismaClient } from '@prisma/client'
import {
  applyReplyBookkeeping,
  createMentionUserAlerts,
  followReplyThread,
  listOpenChannelMentionCandidates,
  mergeMentionCandidates,
  resolveMessageMentions,
  type ReplyRootMetadata,
} from '@nessie/runtime'
import { claimMessageEmbeddingInTransaction } from '@nessie/db'
import {
  PERSON_MESSAGE_AUTHORSHIP,
  TICKET_WORK_STEER_METADATA_KEY,
  type AgentMention,
  type AuthorizedActionContext,
  type MessageEmbedOrigin,
} from '@nessie/schemas'
import {
  deriveConversationTitle,
  enqueueTicketWorkThreadMessage,
} from '@nessie/team-admin'

import { messageInclude, type MessageWithReactions } from './message-read-model.js'
import { canAdminPostInChannel, ChannelPostForbiddenError, prepareChannelMessageInsert } from './channel-posting-policy.js'
import { listAnnouncementRecipients, persistAnnouncementAudience } from './announcement-audience.js'
import { findPendingAgentInvites, resolveAgentMentionsForSend,
  type ChannelAgent } from './message-agent-mentions.js'
import { enqueuePushDispatch } from '../queue/pgqueue.js'

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

// ─── A conversation takes its first message as its title ───────────────────
//
// "New conversation" opens an empty thread, so it has no title at all and two
// of them are indistinguishable in a list. The first thing said in one is its
// name. The derivation is `deriveConversationTitle` — the same helper
// `startAgentConversation` uses for a conversation opened *with* an opening
// line, so there is one title rule and not two.
//
// Every condition is structural, never a reading of the content: the thread is
// a conversation with an agent (`agent_id` set, so a room's General thread is
// never touched), its title is still NULL, and the message is a top-level
// `user` post (the caller passes only that branch). NULL is the whole marker:
// `DEFAULT_CONVERSATION_TITLE` is a legal title a person may type, and while it
// doubled as the "unnamed" sentinel their explicit "New conversation" was
// overwritten by whatever they said first. Rows written before that change
// carry the sentinel and stay named "New conversation" — deliberately, since
// nothing can now tell those two cases apart.
//
// "The first such message" is enforced by the write rather than by a count —
// the conditional `updateMany` carries `title: null` in its WHERE and runs
// inside the send's own transaction, so a second message finds a named
// conversation and two racing first messages cannot both win.
const titleConversationFromFirstMessage = async (
  tx: Prisma.TransactionClient,
  input: {
    content: string
    thread: { agentId: string | null; title: string | null }
    threadId: string
  },
): Promise<string | undefined> => {
  if (!input.thread.agentId) return undefined
  if (input.thread.title !== null) return undefined

  // An attachment-only send has no line to take (`null` here). Leaving the
  // conversation unnamed keeps the naming with the first message that actually
  // says something.
  const title = deriveConversationTitle({ message: input.content })
  if (!title) return undefined

  const renamed = await tx.thread.updateMany({
    where: {
      id: input.threadId,
      agentId: { not: null },
      title: null,
    },
    data: { title },
  })
  return renamed.count > 0 ? title : undefined
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
      // Set only when this message named its conversation (the first top-level
      // user message in an agent thread still carrying the default title), so
      // the client can show the new name without a re-read. Additive: absent on
      // every other send.
      conversationTitle?: string
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

/** The embedding claim a send makes, when the deployment embeds at all. */
export type MessageEmbeddingRequest = { model: string; origin?: MessageEmbedOrigin }

/**
 * A person's send claims its own embedding while their session exists. The
 * sweep that would otherwise claim it has no session, and a signing deployment
 * refuses an embed without the sender's UOA identity.
 */
export const messageEmbeddingForSender = (
  sharedModelClient: { embeddingModel: string } | null | undefined,
  actorContext: AuthorizedActionContext,
): MessageEmbeddingRequest | undefined => {
  if (!sharedModelClient) return undefined
  const uoaIdentity = actorContext.actionContext.uoaIdentity
  return {
    model: sharedModelClient.embeddingModel,
    ...(uoaIdentity && actorContext.actor.actorType === 'user'
      ? { origin: { userId: actorContext.actor.actorId, uoaIdentity } }
      : {}),
  }
}

const claimSentMessageEmbedding = async (
  tx: Prisma.TransactionClient,
  embedding: MessageEmbeddingRequest | undefined,
  message: { content: string; id: string },
  organizationId: string,
): Promise<void> => {
  if (!embedding) return
  await claimMessageEmbeddingInTransaction(tx, {
    content: message.content,
    embeddingModel: embedding.model,
    id: message.id,
    organizationId,
    ...(embedding.origin ? { origin: embedding.origin } : {}),
  })
}

export const createThreadMessage = async (
  prisma: PrismaClient,
  input: {
    content: string
    threadId: string
    userId: string
    rootMessageId?: string
    alsoSendToChannel?: boolean
    requiresConfirmation?: boolean
    agentMentions?: AgentMention[]
    /**
     * Set only by a route whose request is a signed-in person's composer send
     * (`POST /api/threads/:threadId/messages` and a conversation's opening
     * line). Stamped as `metadata.authorship`, the allowlist marker an
     * executor conversation lease carries on; a voice hand-off is written by
     * the voice model's tool call and leaves it unset.
     */
    authorship?: typeof PERSON_MESSAGE_AUTHORSHIP
    actorContext?: AuthorizedActionContext
    /**
     * Set only by the message route, for a person who can edit the board
     * writing in a ticket's work thread: stamped as `metadata.ticketWorkSteer`,
     * the mark a `ticket.work` run's conversation admits a person's words by,
     * with the `ticket-work.thread-message` job enqueued in the same
     * transaction (docs/standards/ticket-work.md → "The work thread").
     */
    ticketWorkSteer?: true
    clientMessageId?: string
    embedding?: MessageEmbeddingRequest
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
          teamId: true,
          organization: { select: { externalOrgId: true } },
          team: { select: { externalTeamId: true } },
          project: { select: { channelRoot: true } },
          adminOnlyPosting: true,
          mandatoryAnnouncements: true,
          systemChannelType: true,
          type: true,
          visibility: true,
        },
      },
      // The conversation this send may name: `agentId` says whether the thread
      // is a conversation with an agent at all, `title` whether it still
      // carries the placeholder one.
      agentId: true,
      title: true,
    },
  })

  if (!thread) {
    return { kind: 'thread_not_found' }
  }
  const isVerifiedAdmin = await canAdminPostInChannel(
    prisma, thread.channel, input.userId, input.actorContext,
  )
  if (input.requiresConfirmation && (
    input.rootMessageId || thread.agentId !== null
    || !thread.channel.adminOnlyPosting || !isVerifiedAdmin
    || thread.channel.visibility !== 'public'
    || input.authorship !== PERSON_MESSAGE_AUTHORSHIP
  )) throw new ChannelPostForbiddenError('Confirmation requires a public read-only administrator post')
  const isAnnouncement = Boolean(
    (thread.channel.mandatoryAnnouncements && isVerifiedAdmin && input.authorship === PERSON_MESSAGE_AUTHORSHIP)
    || input.requiresConfirmation,
  )
  const announcementRecipients = isAnnouncement && input.actorContext
    ? await listAnnouncementRecipients(prisma, thread.channel, input.actorContext, input.userId)
    : []

  const resolvedAgentMentions = await resolveAgentMentionsForSend(prisma, {
    channel: thread.channel,
    content: input.content,
    userId: input.userId,
    agentMentions: input.agentMentions,
  })
  if (resolvedAgentMentions.kind === 'invalid') return { kind: 'invalid_agent_mention' }
  const { agentMentions, channelAgents: resolvedChannelAgents,
    mentionedAgentIds } = resolvedAgentMentions

  // Resolve human + broadcast mentions on the inbound content. Agent mentions
  // are resolved below for engagement; here we record every mention class on
  // message.metadata.mentions so clients can highlight/notify deterministically.
  // Candidates are the channel's members, plus every active organisation member
  // when the channel is open. A non-member of a private or protected channel is
  // never a candidate, so a send that did not invite them writes no alert, no
  // follow and no mention push for them.
  const openMentionCandidates = input.content.includes('@')
    ? await listOpenChannelMentionCandidates(prisma, thread.channel)
    : []
  const mentions = resolveMessageMentions(input.content, {
    members: mergeMentionCandidates(
      thread.channel.members.map((m) => ({
        userId: m.user.id,
        displayName: m.user.displayName,
      })),
      openMentionCandidates,
    ),
  })

  const mergedMentions = {
    ...mentions,
    agentIds: mentionedAgentIds,
    ...(agentMentions.length > 0 ? { agentMentions } : {}),
  }
  // Built here from server-resolved facts only; no client metadata reaches a
  // row, so `authorship` cannot arrive from a request body.
  const authorship = input.authorship === PERSON_MESSAGE_AUTHORSHIP ? { authorship: input.authorship } : {}
  const messageMetadata = {
    mentions: mergedMentions,
    ...authorship,
    ...(input.ticketWorkSteer ? { [TICKET_WORK_STEER_METADATA_KEY]: true } : {}),
  } as Prisma.InputJsonValue

  // A steer in a ticket's work thread wakes the work through its own job,
  // written with the message so neither commits alone (ticket-work-thread.ts).
  const enqueueSteer = async (tx: Prisma.TransactionClient, messageId: string): Promise<void> => {
    if (!input.ticketWorkSteer) return
    await enqueueTicketWorkThreadMessage(tx, { organizationId: thread.channel.organizationId, messageId })
  }

  let message: MessageWithReactions
  let alertedUserIds: string[] = []
  let broadcastMessage: MessageWithReactions | undefined
  let conversationTitle: string | undefined
  let replyRoot: { rootMessageId: string; metadata: ReplyRootMetadata } | undefined

  if (input.rootMessageId) {
    const rootMessageId = input.rootMessageId
    // Reply path (#233): validate the root, create the reply, and apply the
    // root bookkeeping + follows in one transaction so concurrent replies
    // cannot lose counts and a failed validation creates nothing. Replies to
    // replies attach to the same root, so a root that is itself a reply is
    // rejected (one level deep). Tombstoned roots reject new replies.
    const txResult = await prisma.$transaction(async (tx) => {
      const channelPolicy = await prepareChannelMessageInsert(tx, {
        channelId: thread.channel.id,
        isVerifiedAdmin,
        isHumanComposerSend: input.authorship === PERSON_MESSAGE_AUTHORSHIP,
        userId: input.userId,
      })
      if (channelPolicy.mandatoryAnnouncements !== thread.channel.mandatoryAnnouncements
        || channelPolicy.adminOnlyPosting !== thread.channel.adminOnlyPosting) {
        throw new ChannelPostForbiddenError('Channel settings changed. Retry this message.')
      }
      const root = await tx.message.findUnique({
        where: { id: rootMessageId },
        select: { id: true, threadId: true, rootMessageId: true, deletedAt: true, requiresConfirmation: true },
      })
      if (
        !root
        || root.threadId !== input.threadId
        || root.rootMessageId !== null
        || root.deletedAt !== null
        || root.requiresConfirmation
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
          isAnnouncement,
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
              ...authorship,
            } as Prisma.InputJsonValue,
          },
          include: messageInclude,
        })
        : undefined
      await claimSentMessageEmbedding(tx, input.embedding, created, thread.channel.organizationId)
      await enqueueSteer(tx, created.id)
      if (broadcast) {
        await claimSentMessageEmbedding(tx, input.embedding, broadcast, thread.channel.organizationId)
      }
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
      const alerted = isAnnouncement ? await persistAnnouncementAudience(tx, {
        organizationId: thread.channel.organizationId,
        messageId: created.id,
        threadId: input.threadId,
        rootMessageId,
        channelId: thread.channel.id,
        authorUserId: input.userId,
        recipients: announcementRecipients,
        mentionedUserIds: mentions.userIds,
      }) : await createMentionUserAlerts(tx, {
        organizationId: thread.channel.organizationId,
        messageId: created.id,
        threadId: input.threadId,
        channelId: thread.channel.id,
        actorUserId: input.userId,
        mentionedUserIds: mentions.userIds,
      })
      await enqueuePushDispatch(tx, {
        messageId: created.id,
        authorUserId: input.userId,
        channelId: thread.channel.id,
        threadId: input.threadId,
        rootMessageId,
        organizationId: thread.channel.organizationId,
        contentSnippet: created.content.slice(0, 140),
        mentionUserIds: mentions.userIds,
      }, `push:${created.id}`)
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
      const channelPolicy = await prepareChannelMessageInsert(tx, {
        channelId: thread.channel.id,
        isVerifiedAdmin,
        isHumanComposerSend: input.authorship === PERSON_MESSAGE_AUTHORSHIP,
        userId: input.userId,
      })
      if (channelPolicy.mandatoryAnnouncements !== thread.channel.mandatoryAnnouncements
        || channelPolicy.adminOnlyPosting !== thread.channel.adminOnlyPosting) {
        throw new ChannelPostForbiddenError('Channel settings changed. Retry this message.')
      }
      const created = await tx.message.create({
        data: {
          threadId: input.threadId,
          userId: input.userId,
          role: 'user',
          content: input.content,
          ...(input.clientMessageId ? { clientMessageId: input.clientMessageId } : {}),
          metadata: messageMetadata,
          isAnnouncement,
          requiresConfirmation: input.requiresConfirmation === true,
        },
        include: messageInclude,
      })
      await claimSentMessageEmbedding(tx, input.embedding, created, thread.channel.organizationId)
      await enqueueSteer(tx, created.id)
      await followReplyThread(tx, {
        rootMessageId: created.id,
        // A direct mention is an explicit invitation into this reply
        // conversation just as it is for a reply. This keeps the durable
        // Threads inbox independent from whether its alert is later read.
        userIds: [input.userId, ...mentions.userIds],
      })
      const alerted = isAnnouncement ? await persistAnnouncementAudience(tx, {
        organizationId: thread.channel.organizationId,
        messageId: created.id,
        threadId: input.threadId,
        channelId: thread.channel.id,
        authorUserId: input.userId,
        recipients: announcementRecipients,
        mentionedUserIds: mentions.userIds,
      }) : await createMentionUserAlerts(tx, {
        organizationId: thread.channel.organizationId,
        messageId: created.id,
        threadId: input.threadId,
        channelId: thread.channel.id,
        actorUserId: input.userId,
        mentionedUserIds: mentions.userIds,
      })
      await enqueuePushDispatch(tx, {
        messageId: created.id,
        authorUserId: input.userId,
        channelId: thread.channel.id,
        threadId: input.threadId,
        organizationId: thread.channel.organizationId,
        contentSnippet: created.content.slice(0, 140),
        mentionUserIds: mentions.userIds,
      }, `push:${created.id}`)
      // Inside this transaction on purpose: a conversation named by a message
      // that then failed to commit would be named after nothing.
      const namedTitle = await titleConversationFromFirstMessage(tx, {
        content: input.content,
        thread: { agentId: thread.agentId, title: thread.title },
        threadId: input.threadId,
      })
      return {
        message: created,
        alertedUserIds: alerted,
        conversationTitle: namedTitle,
        raced: null,
      }
    }).catch(async (error: unknown) => {
      if (input.clientMessageId && isDuplicateClientKey(error)) {
        const won = await findMessageByClientKey(prisma, input.threadId, input.clientMessageId)
        if (won) {
          return {
            alertedUserIds: [] as string[],
            conversationTitle: undefined,
            message: won,
            raced: won,
          }
        }
      }
      throw error
    })
    if (txResult.raced) {
      return { kind: 'replayed', message: txResult.raced }
    }
    message = txResult.message
    alertedUserIds = txResult.alertedUserIds
    conversationTitle = txResult.conversationTitle
  }

  const pendingAgentInvites = await findPendingAgentInvites(prisma, {
    channel: thread.channel,
    content: input.content,
    userId: input.userId,
    resolved: resolvedAgentMentions,
  })

  return {
    kind: 'created',
    message,
    channelAgents: resolvedChannelAgents,
    alertedUserIds,
    pendingAgentInvites,
    ...(agentMentions.length > 0 ? { agentMentions } : {}),
    ...(replyRoot ? { replyRoot } : {}),
    ...(broadcastMessage ? { broadcastMessage } : {}),
    ...(conversationTitle ? { conversationTitle } : {}),
  }
}
