import type { FastifyInstance } from "fastify";
import type { CredentialStore } from "@nessie/dashboard";
import { AgentCardRespondBodySchema } from "@nessie/schemas";

import { createApiResponse, parseInput, sendApiError } from "../lib/api.js";
import { loadReadableCard, presentAgentCard } from "../services/agent-cards.js";
import {
  AgentCardResponseError,
  respondToAgentCard,
} from "../services/agent-card-response.js";
import type { RouteDeps } from "./types.js";

/**
 * Reading and answering an agent chat card.
 *
 * The press is one transaction: claim the card, place any secret, write the
 * response message. Either all of it happened or none of it did, so a card can
 * never read "resolved" beside a credential that was not stored.
 */
export const registerAgentCardRoutes = (
  app: FastifyInstance,
  deps: RouteDeps & { dashboardCredentials: CredentialStore },
): void => {
  const { prisma, requireActorContext } = deps;

  app.get("/api/agent-cards/:cardId", async (request, reply) => {
    const actorContext = requireActorContext(request, reply);
    if (!actorContext) return reply;

    const { cardId } = request.params as { cardId: string };
    const card = await loadReadableCard(prisma, {
      cardId,
      organizationId: actorContext.tenant.organizationId,
      userId: actorContext.actor.actorId,
    });
    if (!card) {
      sendApiError(reply, 404, "CARD_NOT_FOUND", "Card not found");
      return reply;
    }
    const presented = await presentAgentCard(
      prisma,
      card,
      actorContext.actor.actorId,
    );
    if (!presented) {
      sendApiError(reply, 404, "CARD_NOT_FOUND", "Card not found");
      return reply;
    }
    return createApiResponse(presented);
  });

  app.post("/api/agent-cards/:cardId/respond", async (request, reply) => {
    const actorContext = requireActorContext(request, reply);
    if (!actorContext) return reply;
    const body = parseInput(AgentCardRespondBodySchema, request.body, reply);
    if (!body) return reply;
    const { cardId } = request.params as { cardId: string };
    const card = await loadReadableCard(prisma, {
      cardId,
      organizationId: actorContext.tenant.organizationId,
      userId: actorContext.actor.actorId,
    });
    if (!card) {
      sendApiError(reply, 404, "CARD_NOT_FOUND", "Card not found");
      return reply;
    }
    try {
      const result = await respondToAgentCard(
        { ...deps, dashboardCredentials: deps.dashboardCredentials },
        {
          actionKey: body.actionKey,
          actorContext,
          card,
          secrets: body.secrets,
          values: body.values,
        },
      );
      return createApiResponse(result);
    } catch (error) {
      if (error instanceof AgentCardResponseError) {
        sendApiError(
          reply,
          error.httpStatus,
          error.code,
          error.message,
          error.fieldKeys?.[0],
          error.fieldKeys ? { fieldKeys: error.fieldKeys } : undefined,
        );
        return reply;
      }
      throw error;
    }
  });
};
