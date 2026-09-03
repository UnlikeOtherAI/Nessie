import type { ChannelSystemType, PrismaClient } from '@prisma/client'

import { captureUserMessageMemory, type CaptureConfig } from '@nessie/memory'
import {
  parseChannelId,
  parseThreadId,
  parseUserId,
  type AuthorizedActionContext,
  type WsScope,
} from '@nessie/schemas'

import { enqueueOrchestrateDecide, enqueuePushDispatch } from '../queue/pgqueue.js'
import type { CreateThreadMessageResult } from './message-create.js'

/**
 * Everything that makes a created user message *real*.
 *
 * `createThreadMessage` writes the rows; on its own that message exists and
 * does nothing. It becomes a message people and agents experience here: it is
 * announced to open feeds, it alerts whoever it named, it is pushed to phones,
 * it is remembered, and it wakes the agents bound to its channel.
 *
 * This is one service rather than one route's tail because more than one
 * surface creates a message as the person. The voice call's `pa_send` is the
 * second: a request handed to the assistant mid-call has to start a run
 * indistinguishable from a typed one, and a second copy of this sequence would
 * be a second copy that drifts — a message that pushes but never orchestrates,
 * or orchestrates but never announces itself.
 *
 * What stays with the caller is the HTTP shape of a request: the oversized-body
 * refusal, the secret scan, which pre-uploaded attachments to link, and the
 * response body. What lives here is what is true of the message regardless of
 * who posted it.
 *
 * Every step past the message row is best-effort in the same way it always
 * was: the row is the record of truth, and a failed announcement costs a
 * refresh rather than the message.
 */

type CreatedThreadMessage = Extract<CreateThreadMessageResult, { kind: 'created' }>

type BuildChannelRealtimeScopes = (input: {
  channelId: string
  organizationId: string
  systemChannelType?: string | null
}) => WsScope[]

type MessageRealtimePublisher = {
  publishWs: (
    scopes: WsScope[],
    input: { data: unknown; event: string; ts?: string },
  ) => Promise<unknown>
}

/** Just enough of a Fastify logger to report a step that failed. */
type DeliveryLog = {
  error: (details: Record<string, unknown>, message: string) => void
}

export type MessageDeliveryDeps = {
  buildChannelRealtimeScopes: BuildChannelRealtimeScopes
  /** Null on a deployment with memory capture switched off. */
  messageMemoryCaptureConfig: CaptureConfig | null
  prisma: PrismaClient
  realtimeHub: MessageRealtimePublisher
}

export type DeliveredMessageThread = {
  id: string
  channel: {
    id: string
    systemChannelType: ChannelSystemType | null
    type: 'dm' | 'standard'
  }
}

export type DeliverCreatedMessageInput = {
  actorContext: AuthorizedActionContext
  /** The inbound text, which is what orchestration is asked to decide on. */
  content: string
  log: DeliveryLog
  result: CreatedThreadMessage
  thread: DeliveredMessageThread
}

export const deliverCreatedMessage = async (
  deps: MessageDeliveryDeps,
  input: DeliverCreatedMessageInput,
): Promise<void> => {
  const { actorContext, content, log, result, thread } = input
  const { buildChannelRealtimeScopes, messageMemoryCaptureConfig, prisma, realtimeHub } = deps

  if (messageMemoryCaptureConfig) {
    // Fire-and-forget: memory capture must never delay message posting.
    void captureUserMessageMemory(
      {
        channelId: thread.channel.id,
        content: result.message.content,
        memoryOrigin:
          thread.channel.systemChannelType === 'personal_assistant'
            ? 'personal_assistant_dm'
            : 'user_authored_workspace_message',
        messageId: result.message.id,
        organizationId: actorContext.tenant.organizationId,
        projectId: actorContext.tenant.projectId,
        teamId:
          actorContext.tenant.teamId
          ?? actorContext.actionContext.teamId,
        sourceAudience: thread.channel.type === 'dm' ? 'dm' : 'channel',
        threadId: thread.id,
        userId: actorContext.actor.actorId,
        sessionId: actorContext.actionContext.sessionId,
        taskId: actorContext.actionContext.taskId,
        agentId: actorContext.actionContext.agentId,
        actorId: actorContext.actor.actorId,
        actorType: actorContext.actor.actorType,
        requestId: actorContext.actionContext.requestId,
        correlationId: actorContext.actionContext.correlationId,
        systemComponent: 'memory-capture',
      },
      messageMemoryCaptureConfig,
    ).catch((error) =>
      log.error(
        { err: error, messageId: result.message.id },
        'capture_user_message_memory_failed',
      ))
  }

  const channelScopes = buildChannelRealtimeScopes({
    channelId: thread.channel.id,
    organizationId: actorContext.tenant.organizationId,
    systemChannelType: thread.channel.systemChannelType,
  })

  if (result.replyRoot) {
    // Reply threads (#233): a reply announces itself as `message.reply` (so
    // clients can update the reply panel without touching the top-level
    // feed), followed by the root's fresh materialized metadata.
    await realtimeHub.publishWs(channelScopes, {
      data: {
        agentId: undefined,
        authorUserId: parseUserId(actorContext.actor.actorId),
        channelId: parseChannelId(thread.channel.id),
        contentPreview: result.message.content.slice(0, 200),
        messageId: result.message.id,
        rootMessageId: result.replyRoot.rootMessageId,
        role: result.message.role,
        threadId: parseThreadId(thread.id),
      },
      event: 'message.reply',
    })
    await realtimeHub.publishWs(channelScopes, {
      data: {
        channelId: parseChannelId(thread.channel.id),
        threadId: parseThreadId(thread.id),
        rootMessageId: result.replyRoot.rootMessageId,
        replyCount: result.replyRoot.metadata.replyCount,
        lastReplyAt: result.replyRoot.metadata.lastReplyAt?.toISOString(),
        replyParticipantIds: result.replyRoot.metadata.replyParticipantIds,
      },
      event: 'message.reply.meta',
    })
  } else {
    await realtimeHub.publishWs(channelScopes, {
      data: {
        agentId: undefined,
        authorUserId: parseUserId(actorContext.actor.actorId),
        channelId: parseChannelId(thread.channel.id),
        contentPreview: result.message.content.slice(0, 200),
        messageId: result.message.id,
        role: result.message.role,
        threadId: parseThreadId(thread.id),
      },
      event: 'message.new',
    })
  }

  // "Also send to #channel" copy: a normal top-level `message.new` under the
  // copy's own id. It is informational only — no push/orchestration below.
  if (result.broadcastMessage) {
    await realtimeHub.publishWs(channelScopes, {
      data: {
        agentId: undefined,
        authorUserId: parseUserId(actorContext.actor.actorId),
        channelId: parseChannelId(thread.channel.id),
        contentPreview: result.broadcastMessage.content.slice(0, 200),
        messageId: result.broadcastMessage.id,
        role: result.broadcastMessage.role,
        threadId: parseThreadId(thread.id),
      },
      event: 'message.new',
    })
  }

  // Durable mention alerts were written in the create transaction; fan out
  // one alert.created event per recipient. Best-effort — the rows are the
  // record of truth, a missed event only delays a badge refresh.
  for (const alertedUserId of result.alertedUserIds) {
    try {
      await realtimeHub.publishWs(
        buildChannelRealtimeScopes({
          channelId: thread.channel.id,
          organizationId: actorContext.tenant.organizationId,
          systemChannelType: thread.channel.systemChannelType,
        }),
        {
          data: {
            userId: parseUserId(alertedUserId),
            kind: 'mention' as const,
            messageId: result.message.id,
            threadId: parseThreadId(thread.id),
            channelId: parseChannelId(thread.channel.id),
            actorUserId: parseUserId(actorContext.actor.actorId),
            createdAt: result.message.createdAt.toISOString(),
          },
          event: 'alert.created',
        },
      )
    } catch (error) {
      log.error(
        { err: error, messageId: result.message.id, alertedUserId },
        '[alerts] failed to publish alert.created',
      )
    }
  }

  try {
    const mentions =
      result.message.metadata
      && typeof result.message.metadata === 'object'
      && !Array.isArray(result.message.metadata)
        ? (result.message.metadata as { mentions?: { userIds?: unknown } }).mentions
        : undefined
    const mentionUserIds =
      mentions && Array.isArray(mentions.userIds)
        ? mentions.userIds.filter((id): id is string => typeof id === 'string')
        : []
    await enqueuePushDispatch(
      prisma,
      {
        messageId: result.message.id,
        authorUserId: actorContext.actor.actorId,
        channelId: thread.channel.id,
        threadId: thread.id,
        ...(result.replyRoot ? { rootMessageId: result.replyRoot.rootMessageId } : {}),
        organizationId: actorContext.tenant.organizationId,
        contentSnippet: result.message.content.slice(0, 140),
        mentionUserIds,
      },
      `push:${result.message.id}`,
    )
  } catch (error) {
    log.error(
      { err: error, messageId: result.message.id },
      '[push] failed to enqueue dispatch job — recipients will not be notified',
    )
  }

  if (result.channelAgents.length > 0) {
    // A single-member system DM — the Personal Assistant's, or a global
    // agent's home — is the one place an agent may act as the person it is
    // talking to, and `enqueueOrchestrateDecide` stamps that identity for
    // every wake path from the destination itself. This route used to do it
    // inline, which is precisely why the agent-card press did not.
    try {
      await enqueueOrchestrateDecide(
        prisma,
        {
          actorContext,
          agentMentions: result.agentMentions,
          channelAgents: result.channelAgents,
          channelId: parseChannelId(thread.channel.id),
          content,
          messageId: result.message.id,
          role: result.message.role,
          threadId: parseThreadId(thread.id),
        },
        `orchestrate:${result.message.id}`,
      )
    } catch (error) {
      log.error(
        { err: error, messageId: result.message.id },
        '[orchestrate] failed to enqueue decide job — agent will not respond',
      )
    }
  }
}
