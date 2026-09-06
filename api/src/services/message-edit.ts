import type { PrismaClient } from '@prisma/client'
import { isAgentCardResponseMessage } from '@nessie/schemas'

import { messageInclude, type MessageWithReactions } from './message-read-model.js'

/**
 * Changing a message that already exists: an author's edit, and the soft delete
 * that leaves a tombstone.
 *
 * The only two writes in the messaging service that are not a *new* message, so
 * they carry the two rules that apply to a row already in a transcript: an edit
 * is author-only and refused outright on a card press
 * ([docs/standards/agent-cards.md](../../../docs/standards/agent-cards.md)), and
 * a delete blanks the content while keeping the row so pagination keysets and
 * reply anchors stay stable.
 */

export type UpdateMessageResult =
  | { kind: 'updated'; message: MessageWithReactions }
  | { kind: 'not_found' }
  | { kind: 'forbidden' }
  | { kind: 'immutable' }

export const updateMessage = async (
  prisma: PrismaClient,
  input: { messageId: string; threadId: string; userId: string; content: string },
): Promise<UpdateMessageResult> => {
  const existing = await prisma.message.findFirst({
    where: { id: input.messageId, threadId: input.threadId },
    select: { id: true, userId: true, deletedAt: true, metadata: true },
  })
  if (!existing || existing.deletedAt) {
    return { kind: 'not_found' }
  }
  // Author-only edit.
  if (existing.userId !== input.userId) {
    return { kind: 'forbidden' }
  }
  // A card press is a record, not a remark: the AgentCard row is the authority
  // and this message is its rendering in the chat and in the agent's
  // transcript. Editing it would put a "Deny" beside a card that says "Allow".
  // Deleting stays allowed — a tombstone changes nothing on the card.
  if (isAgentCardResponseMessage(existing.metadata)) {
    return { kind: 'immutable' }
  }

  const message = await prisma.message.update({
    where: { id: input.messageId },
    data: { content: input.content, editedAt: new Date() },
    include: messageInclude,
  })
  return { kind: 'updated', message }
}

export type SoftDeleteMessageResult =
  | { kind: 'deleted'; message: MessageWithReactions }
  | { kind: 'not_found' }
  | { kind: 'forbidden' }

export const softDeleteMessage = async (
  prisma: PrismaClient,
  input: {
    messageId: string
    threadId: string
    userId: string
    isChannelManager: boolean
  },
): Promise<SoftDeleteMessageResult> => {
  const existing = await prisma.message.findFirst({
    where: { id: input.messageId, threadId: input.threadId },
    select: { id: true, userId: true, deletedAt: true },
  })
  if (!existing || existing.deletedAt) {
    return { kind: 'not_found' }
  }
  // Author or channel manager may delete.
  if (existing.userId !== input.userId && !input.isChannelManager) {
    return { kind: 'forbidden' }
  }

  const message = await prisma.message.update({
    where: { id: input.messageId },
    // Blank the content for privacy; the row remains so the UI can render a
    // tombstone and pagination keysets stay stable.
    data: { deletedAt: new Date(), content: '' },
    include: messageInclude,
  })
  return { kind: 'deleted', message }
}
