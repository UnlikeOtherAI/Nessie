import { Prisma } from '@prisma/client'
import { AgentCardMessageMetadataSchema, type AgentCardSpec } from '@nessie/schemas'
import { renderAgentCardPlainText } from '@nessie/team-admin'

import { createAgentMessage } from '../execute/agent-message.js'
import { applyRunReplyBookkeeping } from '../execute/lifecycle.js'
import { publishMessageCreated } from '../execute/realtime.js'
import type { RunContext } from '../execute/types.js'
import { alertCardRespondents } from '../mention-alerts.js'
import type { BuiltinToolRuntimeContext } from '../tool-types.js'
import { buildRealtimeScopesForChannel } from './message-destination.js'

/**
 * Posting one agent chat card: its message, its row and the pointer between
 * them in one transaction, then the reply bookkeeping, the realtime notice and
 * the respondents' bell.
 *
 * `card_post` posts the card a model wrote; a tool that posts a card the
 * server wrote — the executor review card — goes through the same door, so a
 * card can never exist without its message, its notice or its alert, and the
 * pointer is written only after the row exists, so a client never reads a
 * card id that resolves to nothing.
 *
 * Design: docs/plans/2026-09-01-agent-chat-cards.md
 */
export const postAgentCard = async (
  context: BuiltinToolRuntimeContext,
  runContext: RunContext,
  input: {
    card: AgentCardSpec
    expiresAt: Date | null
    /** A prepared executor access change the card opens a review of. */
    executorAccessChangeId?: string
    respondentUserIds: string[]
  },
): Promise<{ cardId: string; messageId: string }> => {
  const created = await context.prisma.$transaction(async (tx) => {
    const message = await createAgentMessage(tx, runContext, {
      agentId: context.agentId,
      content: renderAgentCardPlainText(input.card),
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
        ...(input.executorAccessChangeId
          ? { executorAccessChangeId: input.executorAccessChangeId }
          : {}),
        expiresAt: input.expiresAt,
        messageId: message.id,
        organizationId: context.channel.organizationId,
        respondentUserIds: input.respondentUserIds,
        runId: context.run.id,
        spec: input.card as unknown as Prisma.InputJsonValue,
        threadId: context.run.threadId,
      },
      select: { id: true },
    })
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
  await alertCardRespondents(context, {
    channelId: context.channel.id,
    messageCreatedAt: created.message.createdAt,
    messageId: created.message.id,
    organizationId: context.channel.organizationId,
    recipientUserIds: input.respondentUserIds,
    scopes: buildRealtimeScopesForChannel({
      channelId: context.channel.id,
      organizationId: context.channel.organizationId,
      systemChannelType: context.channel.systemChannelType ?? null,
    }),
    threadId: context.run.threadId,
  })

  return { cardId: created.cardId, messageId: created.message.id }
}
