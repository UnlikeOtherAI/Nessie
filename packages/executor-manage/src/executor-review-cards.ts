import { randomBytes } from 'node:crypto'
import type { Prisma } from '@prisma/client'

import { hashExecutorContinuationValue } from './executor-continuation-security.js'

/**
 * The confirmation card a change prepared in a conversation is reviewed
 * through — an executor access change or a workspace promotion
 * (docs/standards/agent-cards.md → "An executor review card holds an id").
 *
 * The confirmation token is a secret no model may see: the secret scanner
 * rightly redacts it from tool output, which left the chat's review link dead.
 * So the card stores only the change's id, and every press by the person who
 * prepared it mints a fresh token here, inside the press's own transaction.
 * The stored hash is replaced each time, so only the newest token works: the
 * one minted at prepare time (shown to nobody) and any earlier press's die.
 * Confirming is untouched — it still needs the token, the same actor, a pending
 * unexpired change and fresh verification where the change needs it.
 *
 * The card stays open while the change is pending, so a review closed without
 * confirming, a reload, or another device just presses again. It closes when
 * the change does: confirming or rejecting it (through any door) closes it in
 * that same transaction, and it expires with the change.
 */

/** The one action a review card offers; a confirmed change records it. */
export const EXECUTOR_REVIEW_CARD_ACTION_KEY = 'review'
export const EXECUTOR_ALLOW_ACCESS_CARD_ACTION_KEY = 'allow_access'

type ReviewSubject = 'access_change' | 'invocation'

const issueReviewToken = async (
  tx: Prisma.TransactionClient,
  input: { actorUserId: string; continuationId: string; organizationId: string; subject: ReviewSubject },
): Promise<string | null> => {
  const confirmationToken = randomBytes(32).toString('base64url')
  const issued = await tx.executorContinuation.updateMany({
    where: {
      actorUserId: input.actorUserId,
      executor: { organizationId: input.organizationId },
      expiresAt: { gt: new Date() },
      id: input.continuationId,
      status: 'pending',
      subject: input.subject,
    },
    data: { confirmationTokenHash: hashExecutorContinuationValue(confirmationToken) },
  })
  return issued.count === 1 ? confirmationToken : null
}

/**
 * A fresh confirmation token for a pending access change, for the one person
 * who prepared it. Null when there is nothing this person may be handed a
 * token for.
 */
export const issueExecutorAccessChangeConfirmationToken = (
  tx: Prisma.TransactionClient,
  input: { accessChangeId: string; actorUserId: string; organizationId: string },
): Promise<string | null> => issueReviewToken(tx, {
  actorUserId: input.actorUserId,
  continuationId: input.accessChangeId,
  organizationId: input.organizationId,
  subject: 'access_change',
})

/** The same for a pending workspace promotion (an `invocation` continuation). */
export const issueExecutorWorkspacePromotionConfirmationToken = (
  tx: Prisma.TransactionClient,
  input: { actorUserId: string; organizationId: string; promotionId: string },
): Promise<string | null> => issueReviewToken(tx, {
  actorUserId: input.actorUserId,
  continuationId: input.promotionId,
  organizationId: input.organizationId,
  subject: 'invocation',
})

export type ExecutorReviewOutcome = 'confirmed' | 'expired' | 'rejected'

/** A review card a close just ended, for the `card.updated` its caller sends once that commits. */
export type ClosedExecutorReviewCard = {
  channelId: string
  id: string
  messageId: string
  organizationId: string
  status: 'cancelled' | 'expired' | 'resolved'
  threadId: string
}

/**
 * Close every open review card of one change: resolved by its actor when the
 * change was confirmed, cancelled when rejected, expired when it lapsed.
 * Returns the cards this call closed — none that were already closed — so
 * every screen still showing one open can be told after the commit.
 */
export const closeExecutorReviewCards = async (
  tx: Prisma.TransactionClient,
  input: { actorUserId: string; continuationId: string; outcome: ExecutorReviewOutcome },
): Promise<ClosedExecutorReviewCard[]> => {
  const closed = await tx.agentCard.updateManyAndReturn({
    where: {
      OR: [
        { executorAccessChangeId: input.continuationId },
        { executorWorkspacePromotionId: input.continuationId },
      ],
      status: 'open',
    },
    data: input.outcome === 'confirmed'
      ? {
          resolvedActionKey: EXECUTOR_REVIEW_CARD_ACTION_KEY,
          resolvedAt: new Date(),
          resolvedByUserId: input.actorUserId,
          status: 'resolved',
        }
      : { status: input.outcome === 'rejected' ? 'cancelled' : 'expired' },
    select: { channelId: true, id: true, messageId: true, organizationId: true, status: true, threadId: true },
  })
  return closed.map((card) => ({ ...card, status: card.status as ClosedExecutorReviewCard['status'] }))
}

/**
 * What became of a change a press could not mint a token for, or null while
 * it is still pending and unexpired — then it is somebody else's to review,
 * and their card must stay open.
 */
export const settledExecutorReviewOutcome = async (
  tx: Prisma.TransactionClient,
  continuationId: string,
): Promise<{ actorUserId: string; outcome: ExecutorReviewOutcome } | null> => {
  const change = await tx.executorContinuation.findUnique({
    where: { id: continuationId },
    select: { actorUserId: true, expiresAt: true, status: true },
  })
  if (!change) return null
  if (change.status === 'pending' && change.expiresAt > new Date()) return null
  const outcome: ExecutorReviewOutcome = change.status === 'rejected'
    ? 'rejected'
    : change.status === 'pending' || change.status === 'expired' ? 'expired' : 'confirmed'
  return { actorUserId: change.actorUserId, outcome }
}
