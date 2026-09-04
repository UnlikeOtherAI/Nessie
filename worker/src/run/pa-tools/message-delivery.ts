import { Prisma } from '@prisma/client'
import { captureUserMessageMemory } from '@nessie/memory'
import { CHAT_MESSAGE_MAX_CHARS, withActionContext } from '@nessie/schemas'
import {
  parseChannelId,
  parseThreadId,
  parseUserId,
} from '@nessie/schemas'
import { enqueueQueueJob } from '../../queue.js'
import { createMessageMentionAlerts } from '../mention-alerts.js'
import type { BuiltinToolRuntimeContext, ToolExecutionResult } from '../tool-types.js'
import { requireActingUserId } from './access.js'
import {
  buildRealtimeScopesForChannel,
  resolveMessageDestination,
} from './message-destination.js'
import {
  insertMessageBasis,
  resolveToolPostBasis,
} from './tool-message-basis.js'
import { truncate } from './tool-output.js'

const MESSAGE_ATTACHMENT_LIMIT = 10

const attachmentIdsForMessage = (value: unknown): string[] => {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length === 0 || value.length > MESSAGE_ATTACHMENT_LIMIT) {
    throw new Error(`attachmentIds must contain between 1 and ${MESSAGE_ATTACHMENT_LIMIT} IDs.`)
  }
  if (!value.every((id) => typeof id === 'string' && id.trim().length > 0)) {
    throw new Error('attachmentIds must contain only non-empty IDs.')
  }

  const ids = value.map((id) => id.trim())
  if (new Set(ids).size !== ids.length) {
    throw new Error('attachmentIds must not contain duplicates.')
  }
  return ids
}

export const runSendMessageTool = async (
  context: BuiltinToolRuntimeContext,
  input: {
    attachmentIds?: unknown
    channelId?: string
    content: string
    targetUserId?: string
    threadId?: string
  },
): Promise<ToolExecutionResult> => {
  const userId = requireActingUserId(context)
  const content = input.content.trim()
  const attachmentIds = attachmentIdsForMessage(input.attachmentIds)
  if (!content) {
    throw new Error('content is required.')
  }
  if (content.length > CHAT_MESSAGE_MAX_CHARS) {
    throw new Error(
      `Message is ${content.length} characters; the limit is ${CHAT_MESSAGE_MAX_CHARS}.`,
    )
  }

  const destination = await resolveMessageDestination(context, input)
  if (destination.systemChannelType === 'personal_assistant') {
    throw new Error(
      'send_message cannot target the Personal Assistant DM. Reply in the current chat instead.',
    )
  }

  // `send_message` can target a channel other than the one the run is in, so a
  // run holding restricted sources could otherwise relay them somewhere they
  // were never implied. The destination's own chain decides: anything the run
  // consumed that this destination does not imply is stamped on the post.
  const destinationBasis = await resolveToolPostBasis(context, destination.channelId)

  const message = await context.prisma.$transaction(async (tx) => {
    const created = await tx.message.create({
      data: {
        content,
        metadata: {
          delegatedByAgentId: context.agentId,
          delegatedFromRunId: context.run.id,
        } as Prisma.InputJsonValue,
        role: 'user',
        threadId: parseThreadId(destination.threadId),
        userId: parseUserId(userId),
      },
      select: {
        id: true,
        createdAt: true,
        threadId: true,
      },
    })
    if (attachmentIds.length > 0) {
      // Match the REST send boundary: an assistant acts as its effective user,
      // never as the agent row, and can only publish that user's own pending
      // uploads. Rejecting a partial claim keeps the model from reporting an
      // image as sent when a guessed, linked, or foreign attachment was not.
      const linked = await tx.attachment.updateMany({
        where: {
          id: { in: attachmentIds },
          messageId: null,
          organizationId: context.channel.organizationId,
          uploaderId: userId,
        },
        data: { messageId: created.id },
      })
      if (linked.count !== attachmentIds.length) {
        throw new Error(
          'Each attachment must be one of your own still-unlinked uploads in this organization.',
        )
      }
    }
    await insertMessageBasis(tx, {
      basis: destinationBasis,
      messageId: created.id,
      organizationId: String(context.channel.organizationId),
    })
    return created
  })

  // Capture writes this content back as durable memory. A restricted post must
  // not become a memory that later recall serves without the restriction, so a
  // stamped post is not captured at all.
  if (context.memoryCaptureConfig && destinationBasis.length === 0) {
    await captureUserMessageMemory(
      {
        channelId: destination.channelId,
        content,
        memoryOrigin: 'user_authored_team_message',
        messageId: message.id,
        organizationId: context.channel.organizationId,
        projectId: context.actorContext.tenant.projectId,
        teamId:
          context.actorContext.tenant.teamId
          ?? context.actorContext.actionContext.teamId,
        sourceAudience: destination.channelType === 'dm' ? 'dm' : 'channel',
        threadId: destination.threadId,
        userId,
        sessionId: context.actorContext.actionContext.sessionId,
        taskId: context.actorContext.actionContext.taskId,
        runId: context.run.id,
        agentId: context.agentId,
        agentKind: context.agentKind,
        actorId: context.actorContext.actor.actorId,
        actorType: context.actorContext.actor.actorType,
        requestId: context.actorContext.actionContext.requestId,
        correlationId: context.actorContext.actionContext.correlationId,
      },
      context.memoryCaptureConfig,
    )
  }

  await context.realtimeTransport.publishWs(
    buildRealtimeScopesForChannel({
      channelId: destination.channelId,
      organizationId: context.channel.organizationId,
      systemChannelType: destination.systemChannelType,
    }),
    {
      data: {
        agentId: undefined,
        channelId: parseChannelId(destination.channelId),
        // Channel-wide push: a restricted post goes out content-free, since the
        // wire reaches every connected member regardless of entitlement.
        ...(destinationBasis.length > 0
          ? { restricted: true }
          : { contentPreview: content.slice(0, 200) }),
        messageId: message.id,
        role: 'user',
        threadId: parseThreadId(destination.threadId),
      },
      event: 'message.new',
    },
  )

  // Agent-authored @mentions (the PA posting as its owner) create the same
  // durable alerts as human-authored ones — but never for a restricted post,
  // which would hand a non-entitled recipient its existence and a way in.
  if (destinationBasis.length === 0) {
    await createMessageMentionAlerts(
      { prisma: context.prisma, realtimeTransport: context.realtimeTransport },
      {
        organizationId: context.channel.organizationId,
        channelId: destination.channelId,
        threadId: destination.threadId,
        messageId: message.id,
        messageCreatedAt: message.createdAt,
        content,
        actorUserId: userId,
        actorAgentId: context.agentId,
        scopes: buildRealtimeScopesForChannel({
          channelId: destination.channelId,
          organizationId: context.channel.organizationId,
          systemChannelType: destination.systemChannelType,
        }),
      },
    )
  }

  let queuedReplyCount = 0
  if (destination.channelAgents.length > 0) {
    const enqueued = await enqueueQueueJob(
      context.prisma,
      {
        idempotencyKey: `orchestrate:${message.id}`,
        payload: {
          actorContext: withActionContext(context.actorContext, {
            channelId: parseChannelId(destination.channelId),
            effectiveUserId: parseUserId(userId),
            threadId: parseThreadId(destination.threadId),
          }),
          channelAgents: destination.channelAgents,
          channelId: parseChannelId(destination.channelId),
          content,
          messageId: message.id,
          role: 'user',
          threadId: parseThreadId(destination.threadId),
        },
        topic: 'orchestrate.decide',
      },
    )
    queuedReplyCount = enqueued ? destination.channelAgents.length : 0
  }

  const destinationSummary =
    input.targetUserId
      ? `DM sent to userId=${input.targetUserId}`
      : input.threadId
        ? `Message sent to threadId=${destination.threadId}`
        : input.channelId
          ? `Message sent to channelId=${destination.channelId}`
          : `Message sent to current threadId=${destination.threadId}`

  return {
    inputSummary: truncate(content, 200),
    outputPreview: [
      destinationSummary,
      `channelId=${destination.channelId} | channel="${destination.channelLabel}" | scope="${destination.channelScope}"`,
      `threadId=${destination.threadId}${destination.threadLabel ? ` | thread="${destination.threadLabel}"` : ''}`,
      `messageId=${message.id}`,
      `attachmentsLinked=${attachmentIds.length}`,
      `agentsNotified=${queuedReplyCount}`,
    ].join('\n'),
    toolName: 'send_message',
  }
}
