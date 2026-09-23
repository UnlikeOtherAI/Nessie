import type { PrismaClient } from "@prisma/client";
import {
  closeExecutorReviewCards,
  issueExecutorAccessChangeConfirmationToken,
  issueExecutorWorkspacePromotionConfirmationToken,
  settledExecutorReviewOutcome,
} from "@nessie/executor-manage";
import type { AgentCardRespondResult, AuthorizedActionContext } from "@nessie/schemas";

import { emitAuditEvent } from "./audit.js";
import type { LoadedAgentCard } from "./agent-cards.js";

/** The change a system-authored executor review card opens, if it is one. */
export const executorReviewOf = (
  card: Pick<LoadedAgentCard, "executorAccessChangeId" | "executorWorkspacePromotionId">,
): { accessChangeId: string } | { promotionId: string } | null =>
  card.executorAccessChangeId
    ? { accessChangeId: card.executorAccessChangeId }
    : card.executorWorkspacePromotionId
      ? { promotionId: card.executorWorkspacePromotionId }
      : null;

type Refusal = { code: "CARD_NOT_OPEN" | "EXECUTOR_ACCESS_CHANGE_STALE"; message: string };

/**
 * A press of an executor review card: a fresh confirmation token for the
 * presser, and nothing else.
 *
 * It resolves nothing. Pressing used to claim the card and hand back the only
 * token once, held in the renderer's memory — so a review closed without
 * confirming, a reload, a response lost in transit or another device left a
 * resolved card beside a change still pending that no screen could confirm.
 * Now the card stays open while its change is pending and every press mints a
 * new token (only the newest works), and the card closes when the change does:
 * confirming or rejecting it closes it in that transaction
 * (`closeExecutorReviewCards`), and it expires with the change. A press finds
 * a change that is over — confirmed or rejected elsewhere, or lapsed — closes
 * the card to match and refuses, so a stale card never keeps a live button. A
 * change still pending for somebody else refuses and leaves their card alone.
 *
 * No response message, no agent wake: the review is the person's to finish,
 * and a message per press would only repeat "Review".
 */
export const pressExecutorReviewCard = async (
  prisma: PrismaClient,
  input: { actorContext: AuthorizedActionContext; card: LoadedAgentCard; userId: string },
): Promise<{ refused: Refusal } | { result: AgentCardRespondResult }> => {
  const { card, userId } = input;
  const review = executorReviewOf(card);
  if (!review) throw new Error("Not an executor review card.");
  const continuationId = "accessChangeId" in review ? review.accessChangeId : review.promotionId;
  const minted = await prisma.$transaction(async (tx) => {
    const now = new Date();
    const open = await tx.agentCard.count({
      where: {
        id: card.id,
        OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
        status: "open",
      },
    });
    if (open !== 1) return { closed: false, token: null, wasOpen: false };
    const issue = { actorUserId: userId, organizationId: card.organizationId };
    const token = "accessChangeId" in review
      ? await issueExecutorAccessChangeConfirmationToken(tx, { ...issue, accessChangeId: review.accessChangeId })
      : await issueExecutorWorkspacePromotionConfirmationToken(tx, { ...issue, promotionId: review.promotionId });
    if (token) return { closed: false, token, wasOpen: true };
    const settled = await settledExecutorReviewOutcome(tx, continuationId);
    if (settled) await closeExecutorReviewCards(tx, { ...settled, continuationId });
    return { closed: settled !== null, token: null, wasOpen: true };
  });
  if (!minted.wasOpen) {
    return { refused: { code: "CARD_NOT_OPEN", message: "This card has already been answered or is no longer open." } };
  }
  if (!minted.token) {
    return {
      refused: {
        code: "EXECUTOR_ACCESS_CHANGE_STALE",
        message: minted.closed
          ? "This change is no longer waiting for your review. Ask for it again."
          : "This change is waiting for somebody else's review.",
      },
    };
  }
  // The audit trail records the press, never the token.
  await emitAuditEvent(prisma, {
    action: "agent_card.responded",
    actorContext: input.actorContext,
    metadata: { actionKey: "review", executorReview: "accessChangeId" in review ? "access_change" : "workspace_promotion" },
    outcome: "success",
    resourceId: card.id,
    resourceType: "agent_card",
  });
  return {
    result: {
      cardId: card.id,
      executorReview: { ...review, confirmationToken: minted.token },
      status: "open",
    },
  };
};
