import {
  closeExecutorReviewCards,
  issueExecutorAccessChangeConfirmationToken,
  issueExecutorWorkspacePromotionConfirmationToken,
  settledExecutorReviewOutcome,
  type ClosedExecutorReviewCard,
} from "@nessie/executor-manage";
import { parseThreadId, type AgentCardRespondResult, type AuthorizedActionContext } from "@nessie/schemas";

import { emitAuditEvent } from "./audit.js";
import type { LoadedAgentCard } from "./agent-cards.js";
import type { RouteDeps } from "../routes/types.js";

type ReviewCardDeps = Pick<RouteDeps, "buildChannelRealtimeScopes" | "prisma" | "realtimeHub">;

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
 * Tell every screen showing these review cards that they closed. The close
 * committed with the change — or with the press that found it over — so this
 * runs after it and is logged, never thrown: a failed notice costs those
 * screens a refresh, never the confirm. Without it the preparer's other
 * devices kept a live Review button, and the rest of the room an open card,
 * until they reloaded.
 */
export const announceClosedExecutorReviewCards = async (
  deps: ReviewCardDeps,
  cards: readonly ClosedExecutorReviewCard[],
): Promise<void> => {
  for (const card of cards) {
    try {
      const channel = await deps.prisma.channel.findUnique({
        where: { id: card.channelId },
        select: { systemChannelType: true, visibility: true },
      });
      await deps.realtimeHub.publishWs(
        deps.buildChannelRealtimeScopes({
          channelId: card.channelId,
          organizationId: card.organizationId,
          systemChannelType: channel?.systemChannelType ?? null,
          ...(channel ? { visibility: channel.visibility } : {}),
        }),
        {
          data: {
            cardId: card.id,
            messageId: card.messageId,
            status: card.status,
            threadId: parseThreadId(card.threadId),
          },
          event: "card.updated",
        },
      );
    } catch (error) {
      console.error("[agent-card] card.updated publish failed after the review card closed", {
        cardId: card.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
};

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
 * the card to match, tells every screen showing it, and refuses, so a stale
 * card never keeps a live button. A change still pending for somebody else
 * refuses and leaves their card alone.
 *
 * No response message, no agent wake: the review is the person's to finish,
 * and a message per press would only repeat "Review".
 */
export const pressExecutorReviewCard = async (
  deps: ReviewCardDeps,
  input: { actorContext: AuthorizedActionContext; card: LoadedAgentCard; userId: string },
): Promise<{ refused: Refusal } | { result: AgentCardRespondResult }> => {
  const { prisma } = deps;
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
    if (open !== 1) return { closed: [], settled: false, token: null, wasOpen: false };
    const issue = { actorUserId: userId, organizationId: card.organizationId };
    const token = "accessChangeId" in review
      ? await issueExecutorAccessChangeConfirmationToken(tx, { ...issue, accessChangeId: review.accessChangeId })
      : await issueExecutorWorkspacePromotionConfirmationToken(tx, { ...issue, promotionId: review.promotionId });
    if (token) return { closed: [], settled: false, token, wasOpen: true };
    const settled = await settledExecutorReviewOutcome(tx, continuationId);
    const closed = settled ? await closeExecutorReviewCards(tx, { ...settled, continuationId }) : [];
    return { closed, settled: settled !== null, token: null, wasOpen: true };
  });
  await announceClosedExecutorReviewCards(deps, minted.closed);
  if (!minted.wasOpen) {
    return { refused: { code: "CARD_NOT_OPEN", message: "This card has already been answered or is no longer open." } };
  }
  if (!minted.token) {
    return {
      refused: {
        code: "EXECUTOR_ACCESS_CHANGE_STALE",
        message: minted.settled
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
