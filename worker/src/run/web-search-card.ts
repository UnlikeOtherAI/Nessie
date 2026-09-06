import type { Prisma } from '@prisma/client'
import {
  renderWebSearchCardPlainText,
  toWebSearchCard,
  type WebSearchOutput,
} from '@nessie/runtime'
import { WebSearchCardMessageMetadataSchema } from '@nessie/schemas'

import { createAgentMessage } from './execute/agent-message.js'
import { applyRunReplyBookkeeping } from './execute/lifecycle.js'
import { publishMessageCreated } from './execute/realtime.js'
import type { BuiltinToolRuntimeContext } from './tool-types.js'

/**
 * Post a page of web results into the conversation as a search card.
 *
 * The message is an ordinary assistant message — it sits in the thread, the
 * unread counters, search and the model's own transcript like anything else the
 * agent says — and carries the card in its metadata. Nothing about it is
 * interactive on the server: paging happens in the browser against
 * `POST /api/web-search`, so there is no row to claim and no press to settle.
 *
 * Mirrors `runCardPostTool`'s write path deliberately: same message creation,
 * same reply bookkeeping, same realtime publish. A second way to put an agent's
 * message in a channel is the defect Rule zero names.
 */
export const postWebSearchCard = async (
  context: BuiltinToolRuntimeContext,
  output: WebSearchOutput,
): Promise<{ card: ReturnType<typeof toWebSearchCard>; messageId: string }> => {
  const runContext = context.runContext
  if (!runContext) {
    throw new Error('Unable to resolve the current conversation.')
  }

  const card = toWebSearchCard(output)
  const content = renderWebSearchCardPlainText(card)

  const message = await createAgentMessage(context.prisma, runContext, {
    agentId: context.agentId,
    content,
    metadata: WebSearchCardMessageMetadataSchema.parse({
      webSearch: card,
    }) as unknown as Prisma.InputJsonValue,
    role: 'assistant',
    threadId: context.run.threadId,
    ...(runContext.replyRootMessageId
      ? { rootMessageId: runContext.replyRootMessageId }
      : {}),
  })

  const reply = runContext.replyRootMessageId
    ? await applyRunReplyBookkeeping(context.prisma, runContext, message.createdAt)
    : undefined
  await publishMessageCreated(context.realtimeTransport, runContext, {
    content: message.content,
    messageId: message.id,
    role: 'assistant',
    ...(message.basis.length > 0 ? { restricted: true } : {}),
    ...(reply ? { reply } : {}),
  })

  return { card, messageId: message.id }
}
