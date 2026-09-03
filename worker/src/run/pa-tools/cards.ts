import { Prisma } from '@prisma/client'
import {
  AgentCardMessageMetadataSchema,
  CardPostToolInputSchema,
  CardPostToolOutputSchema,
  type AgentCardSpec,
} from '@nessie/schemas'
import { renderAgentCardPlainText } from '@nessie/team-admin'

import { createAgentMessage } from '../execute/agent-message.js'
import { applyRunReplyBookkeeping } from '../execute/lifecycle.js'
import { publishMessageCreated } from '../execute/realtime.js'
import type { BuiltinToolRuntimeContext, ToolExecutionResult } from '../tool-types.js'
import { alertCardRespondents } from '../mention-alerts.js'
import { buildRealtimeScopesForChannel } from './message-destination.js'
import { assertCardSecretDestinations } from './card-secrets.js'

/**
 * `card_post` — the one tool behind every agent chat card.
 *
 * The card row is the authority and the message carries only its id; the
 * message exists so the card sits in the thread, the unread counters, search,
 * notifications and the model's own transcript window like anything else said
 * in the conversation.
 *
 * Design: docs/plans/2026-09-01-agent-chat-cards.md
 */

/**
 * An image block names an attachment, never a URL, so a card can only show
 * something the run could already see. Reach is the `attachment_read` rule:
 * message-linked, same organisation, and inside a channel the reader can see —
 * with an autonomous run bounded by its own channel.
 */
const assertReachableImages = async (
  context: BuiltinToolRuntimeContext,
  spec: AgentCardSpec,
): Promise<void> => {
  const attachmentIds = spec.blocks.flatMap((block) =>
    block.type === 'image' ? [block.attachmentId] : [],
  )
  if (attachmentIds.length === 0) return

  const readerId =
    context.actorContext.actor.actorType === 'user'
      ? context.actorContext.actor.actorId
      : context.actorContext.actionContext.effectiveUserId ?? null

  for (const attachmentId of attachmentIds) {
    const attachment = await context.prisma.attachment.findUnique({
      select: { id: true, messageId: true, mime: true, organizationId: true },
      where: { id: attachmentId },
    })
    if (
      !attachment
      || attachment.organizationId !== context.channel.organizationId
      || !attachment.messageId
    ) {
      throw new Error(`Attachment ${attachmentId} is not available to show on a card.`)
    }
    if (!attachment.mime.startsWith('image/')) {
      throw new Error(`Attachment ${attachmentId} is not an image.`)
    }
    const visibleMessage = await context.prisma.message.findFirst({
      select: { id: true },
      where: {
        id: attachment.messageId,
        thread: {
          channel: readerId
            ? { members: { some: { userId: readerId } }, organizationId: attachment.organizationId }
            : { id: context.channel.id, organizationId: attachment.organizationId },
        },
      },
    })
    if (!visibleMessage) {
      throw new Error(`Attachment ${attachmentId} is not available to show on a card.`)
    }
  }
}

/**
 * Who the agent asked. `requester` is the default when a person actually asked
 * for this run: an "Allow" pressed by a bystander on somebody else's behalf is
 * the failure worth avoiding. An unattended run has no requester, so it falls
 * back to the thread — whoever reads the channel answers.
 */
const resolveRespondentUserIds = async (
  context: BuiltinToolRuntimeContext,
  respondents: ReturnType<typeof CardPostToolInputSchema.parse>['respondents'],
): Promise<string[]> => {
  const requesterId = context.run.originatingUserId ?? context.run.principalUserId ?? null
  const choice = respondents ?? (requesterId ? 'requester' : 'thread')

  if (choice === 'thread') return []
  if (choice === 'requester') {
    if (!requesterId) {
      throw new Error(
        'This run has no requesting person, so respondents:"requester" has nobody to ask. '
        + 'Use "thread" or name userIds.',
      )
    }
    return [requesterId]
  }

  const requested = [...new Set(choice.userIds)]
  // Never ask somebody who cannot see the card: they would be named as the
  // blocker on a card they can never open.
  const reachable = await context.prisma.channelMember.findMany({
    select: { userId: true },
    where: { channelId: context.channel.id, userId: { in: requested } },
  })
  const reachableIds = new Set(reachable.map((member) => member.userId))
  const unreachable = requested.filter((userId) => !reachableIds.has(userId))
  if (unreachable.length > 0) {
    throw new Error(
      `These people are not in this conversation and cannot answer a card here: ${unreachable.join(', ')}.`,
    )
  }
  return requested
}

export const runCardPostTool = async (
  context: BuiltinToolRuntimeContext,
  input: Record<string, unknown>,
): Promise<ToolExecutionResult> => {
  const parsed = CardPostToolInputSchema.safeParse(input)
  if (!parsed.success) {
    throw new Error(parsed.error.issues[0]?.message ?? 'That card is not valid.')
  }
  const args = parsed.data
  const runContext = context.runContext
  if (!runContext) {
    throw new Error('Unable to resolve the current conversation.')
  }

  await assertReachableImages(context, args.card)
  // Validated at post time, not at press time: a card offering to store a
  // credential somewhere it cannot go should never be shown to anybody.
  const secretDestinations = await assertCardSecretDestinations(context, args.card)

  const respondentUserIds = await resolveRespondentUserIds(context, args.respondents)
  const content = renderAgentCardPlainText(args.card)
  const expiresAt = args.expiresIn
    ? new Date(Date.now() + args.expiresIn * 1000)
    : null

  const created = await context.prisma.$transaction(async (tx) => {
    const message = await createAgentMessage(tx, runContext, {
      agentId: context.agentId,
      content,
      role: 'assistant',
      threadId: context.run.threadId,
      ...(runContext.replyRootMessageId
        ? { rootMessageId: runContext.replyRootMessageId }
        : {}),
    })
    const card = await tx.agentCard.create({
      data: {
        agentId: context.agentId,
        channelId: context.channel.id,
        expiresAt,
        messageId: message.id,
        organizationId: context.channel.organizationId,
        respondentUserIds,
        runId: context.run.id,
        spec: args.card as unknown as Prisma.InputJsonValue,
        threadId: context.run.threadId,
      },
      select: { id: true },
    })
    // The pointer is written after the row exists, so a client can never read
    // a card id that resolves to nothing.
    await tx.message.update({
      data: {
        metadata: AgentCardMessageMetadataSchema.parse({
          agentCard: { cardId: card.id, schemaVersion: 1 },
        }) as unknown as Prisma.InputJsonValue,
      },
      where: { id: message.id },
    })
    return { cardId: card.id, message }
  })

  const reply = runContext.replyRootMessageId
    ? await applyRunReplyBookkeeping(context.prisma, runContext, created.message.createdAt)
    : undefined
  await publishMessageCreated(context.realtimeTransport, runContext, {
    content: created.message.content,
    messageId: created.message.id,
    role: 'assistant',
    ...(created.message.basis.length > 0 ? { restricted: true } : {}),
    ...(reply ? { reply } : {}),
  })

  // Named respondents are being asked for something, so they get the ordinary
  // mention bell and push. A thread-wide card alerts nobody: it is read like
  // any other channel message.
  if (respondentUserIds.length > 0) {
    await alertCardRespondents(context, {
      channelId: context.channel.id,
      messageCreatedAt: created.message.createdAt,
      messageId: created.message.id,
      organizationId: context.channel.organizationId,
      recipientUserIds: respondentUserIds,
      scopes: buildRealtimeScopesForChannel({
        channelId: context.channel.id,
        organizationId: context.channel.organizationId,
        systemChannelType: context.channel.systemChannelType ?? null,
      }),
      threadId: context.run.threadId,
    })
  }

  const output = CardPostToolOutputSchema.parse({
    cardId: created.cardId,
    messageId: created.message.id,
    status: 'open' as const,
  })

  return {
    inputSummary:
      `title=${args.card.title}; actions=${args.card.actions.length}`
      + `; respondents=${respondentUserIds.length === 0 ? 'thread' : respondentUserIds.length}`
      + `${args.wait ? '; wait' : ''}`
      + `${secretDestinations.length > 0 ? `; secrets=${secretDestinations.length}` : ''}`,
    outputPreview: JSON.stringify(output),
    ...(args.wait ? { pendingInput: { cardId: created.cardId } } : {}),
    toolName: 'card_post',
  }
}
