import { forgetMessageThoughts } from "@nessie/memory";
import { type AuthorizedActionContext, parseThreadId } from "@nessie/schemas";

import { emitAuditEvent } from "./audit.js";
import type { LoadedAgentCard } from "./agent-cards.js";
import { publishMessageReply } from "./message-delivery.js";
import type { RouteDeps } from "../routes/types.js";

type AnnounceDeps = Pick<
  RouteDeps,
  | "buildChannelRealtimeScopes"
  | "messageMemoryCaptureConfig"
  | "prisma"
  | "realtimeHub"
>;

/**
 * One step after the press committed. It is logged and never thrown: the
 * claim, the response message and the resume are already durable, so a failed
 * announcement costs a refresh, never the press. Throwing here answered 500 for
 * a card the server had already resolved, and the person saw "Something went
 * wrong" beside a button that still looked pressable.
 */
const afterCommit = async (
  step: string,
  cardId: string,
  action: () => Promise<unknown>,
): Promise<void> => {
  try {
    await action();
  } catch (error) {
    console.error(`[agent-card] ${step} failed after the press committed`, {
      cardId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
};

/**
 * Everything a committed card press tells the rest of the system: the audit
 * trail, the redaction of any message a secret field replaced, the card's new
 * status and the response message. A failed step never stops a later one.
 */
export const announceAgentCardResponse = async (
  deps: AnnounceDeps,
  input: {
    actionKey: string;
    actorContext: AuthorizedActionContext;
    card: LoadedAgentCard;
    content: string;
    responseMessageId: string;
    responseRestricted: boolean;
    rootMessageId: string;
    secretKeys: string[];
    secretOutcomes: Record<string, unknown>;
    userId: string;
    valueKeys: string[];
  },
): Promise<void> => {
  const { actorContext, card } = input;
  // `emitAuditEvent` already swallows its own failure; it is the audit trail,
  // so it runs first and is never skipped by a failed publish.
  await emitAuditEvent(deps.prisma, {
    action: "agent_card.responded",
    actorContext,
    metadata: {
      actionKey: input.actionKey,
      secretKeys: input.secretKeys,
      valueKeys: input.valueKeys,
    },
    outcome: "success",
    resourceId: card.id,
    resourceType: "agent_card",
  });
  // A guarded step like the publishes it feeds: scopes that cannot be built
  // skip every publish (the audit and the thought cleanup still run) rather
  // than failing a press that already committed.
  let scopes: ReturnType<AnnounceDeps["buildChannelRealtimeScopes"]> | null = null;
  await afterCommit("realtime scopes", card.id, async () => {
    scopes = deps.buildChannelRealtimeScopes({
      channelId: card.channelId,
      organizationId: card.organizationId,
      systemChannelType: card.channel.systemChannelType,
      visibility: card.channel.visibility,
    });
  });
  const publish = (step: string, action: (built: NonNullable<typeof scopes>) => Promise<unknown>) =>
    afterCommit(step, card.id, () => (scopes ? action(scopes) : Promise.resolve()));
  for (const [key, value] of Object.entries(input.secretOutcomes)) {
    const stored = value as {
      kind?: string;
      redactedMessageId?: string;
      reference?: string;
      scopeType?: string;
    };
    if (stored.kind !== "vault_secret") continue;
    await emitAuditEvent(deps.prisma, {
      action: "secret.created",
      actorContext,
      metadata: { cardId: card.id, fieldKey: key, scopeType: stored.scopeType },
      outcome: "success",
      resourceId: stored.reference ?? card.id,
      resourceType: "secret",
    });
    const redactedMessageId = stored.redactedMessageId;
    if (!redactedMessageId) continue;
    if (deps.messageMemoryCaptureConfig)
      await forgetMessageThoughts(
        { messageId: redactedMessageId, organizationId: card.organizationId },
        deps.messageMemoryCaptureConfig.pool,
      ).catch(() => undefined);
    await emitAuditEvent(deps.prisma, {
      action: "message.redacted",
      actorContext,
      metadata: { cardId: card.id, fieldKey: key },
      outcome: "success",
      resourceId: redactedMessageId,
      resourceType: "message",
    });
    await publish("message.updated publish", (built) =>
      deps.realtimeHub.publishWs(built, {
        data: {
          editedAt: new Date().toISOString(),
          messageId: redactedMessageId,
          threadId: parseThreadId(card.threadId),
        },
        event: "message.updated",
      }));
  }
  await publish("card.updated publish", (built) =>
    deps.realtimeHub.publishWs(built, {
      data: {
        cardId: card.id,
        messageId: card.messageId,
        status: "resolved" as const,
        threadId: parseThreadId(card.threadId),
      },
      event: "card.updated",
    }));
  await afterCommit("message.reply publish", card.id, () =>
    publishMessageReply(
      {
        buildChannelRealtimeScopes: deps.buildChannelRealtimeScopes,
        realtimeHub: deps.realtimeHub,
      },
      {
        channel: {
          id: card.channelId,
          organizationId: card.organizationId,
          systemChannelType: card.channel.systemChannelType,
          visibility: card.channel.visibility,
        },
        message: {
          content: input.content,
          id: input.responseMessageId,
          ...(input.responseRestricted ? { restricted: true } : {}),
          role: "user",
          userId: input.userId,
        },
        rootMessageId: input.rootMessageId,
        threadId: card.threadId,
      },
    ));
};
