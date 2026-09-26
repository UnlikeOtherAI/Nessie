import type { PrismaClient } from '@prisma/client'
import { isAgentCardResponseMessage, isResearchRunRefMessage } from '@nessie/schemas'
import type { AuthorizedActionContext } from '@nessie/schemas'
import { writeAuditEntryInTransaction } from '@nessie/db'

import { messageInclude, type MessageWithReactions } from './message-read-model.js'
import { canAdminPostInChannel } from './channel-posting-policy.js'

/**
 * Changing a message that already exists: an author's edit, and the soft delete
 * that leaves a tombstone.
 *
 * The only two writes in the messaging service that are not a *new* message, so
 * they carry the two rules that apply to a row already in a transcript: an edit
 * is author-only and refused outright on a card press or a research card
 * ([docs/standards/agent-cards.md](../../../docs/standards/agent-cards.md)), and
 * a delete blanks the content while keeping the row so pagination keysets and
 * reply anchors stay stable.
 */

export type UpdateMessageResult =
  | { kind: 'updated'; message: MessageWithReactions }
  | { kind: 'not_found' }
  | { kind: 'forbidden' }
  /** A card press, or the research card a person's research was started from. */
  | { kind: 'immutable'; record: 'card_response' | 'research_card' | 'confirmation' }

export const updateMessage = async (
  prisma: PrismaClient,
  input: { messageId: string; threadId: string; userId: string; content: string;
    actorContext?: AuthorizedActionContext },
): Promise<UpdateMessageResult> => {
  const existing = await prisma.message.findFirst({
    where: { id: input.messageId, threadId: input.threadId },
    select: { id: true, userId: true, deletedAt: true, metadata: true, requiresConfirmation: true,
      thread: { select: { channel: { select: {
        id: true, organizationId: true, teamId: true, type: true, systemChannelType: true,
        adminOnlyPosting: true, organization: { select: { externalOrgId: true } },
        team: { select: { externalTeamId: true } },
      } } } },
    },
  })
  if (!existing || existing.deletedAt) {
    return { kind: 'not_found' }
  }
  // Author-only edit.
  if (existing.userId !== input.userId) {
    return { kind: 'forbidden' }
  }
  if (existing.thread.channel.adminOnlyPosting && !(await canAdminPostInChannel(
    prisma, existing.thread.channel, input.userId, input.actorContext,
  ))) return { kind: 'forbidden' }
  if (existing.requiresConfirmation) return { kind: 'immutable', record: 'confirmation' }
  // A card press is a record, not a remark: the AgentCard row is the authority
  // and this message is its rendering in the chat and in the agent's
  // transcript. Editing it would put a "Deny" beside a card that says "Allow".
  // Deleting stays allowed — a tombstone changes nothing on the card.
  if (isAgentCardResponseMessage(existing.metadata)) {
    return { kind: 'immutable', record: 'card_response' }
  }
  // A research card points at its run, and its words are the topic the
  // person started it with: edited, it would name a research that is not the
  // one it shows. Deleting it stays allowed; the research is untouched.
  if (isResearchRunRefMessage(existing.metadata)) {
    return { kind: 'immutable', record: 'research_card' }
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
    actorContext?: AuthorizedActionContext
  },
): Promise<SoftDeleteMessageResult> => {
  const existing = await prisma.message.findFirst({
    where: { id: input.messageId, threadId: input.threadId },
    select: { id: true, userId: true, deletedAt: true, requiresConfirmation: true,
      thread: { select: { channel: { select: {
        id: true, organizationId: true, projectId: true, teamId: true,
        type: true, systemChannelType: true,
        adminOnlyPosting: true, organization: { select: { externalOrgId: true } },
        team: { select: { externalTeamId: true } },
      } } } },
    },
  })
  if (!existing || existing.deletedAt) {
    return { kind: 'not_found' }
  }
  // Only the author deletes a message. Nobody else — a fellow channel member,
  // an organisation owner or admin, a team role — may remove what somebody
  // else said (`docs/standards/team-model.md` → "Who may change a project or a
  // channel").
  if (existing.userId !== input.userId) {
    return { kind: 'forbidden' }
  }
  if (existing.thread.channel.adminOnlyPosting && !(await canAdminPostInChannel(
    prisma, existing.thread.channel, input.userId, input.actorContext,
  ))) return { kind: 'forbidden' }

  const message = await prisma.$transaction(async (tx) => {
    if (existing.requiresConfirmation) {
      // Lock the outstanding receipts before the message. The reminder worker
      // takes the same order, so a send and cancellation have one winner.
      await tx.announcementDelivery.updateMany({
        where: { messageId: input.messageId, acknowledgedAt: null,
          reminderMessageId: null },
        data: { reminderError: 'Announcement removed' },
      })
    }
    const deleted = await tx.message.update({
      where: { id: input.messageId },
      // Blank the content for privacy; the row remains so the UI can render a
      // tombstone and pagination keysets stay stable.
      data: { deletedAt: new Date(), content: '' },
      include: messageInclude,
    })
    if (existing.requiresConfirmation && input.actorContext) {
      await writeAuditEntryInTransaction(tx, {
        organizationId: existing.thread.channel.organizationId,
        projectId: existing.thread.channel.projectId,
        teamId: existing.thread.channel.teamId,
        channelId: existing.thread.channel.id,
        actorType: 'user', actorId: input.userId,
        action: 'announcement.cancelled', resourceType: 'announcement',
        resourceId: input.messageId, outcome: 'success',
        requestId: input.actorContext.actionContext.requestId,
      })
    }
    return deleted
  })
  return { kind: 'deleted', message }
}
