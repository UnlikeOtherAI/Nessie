import { Prisma } from "@prisma/client";
import { adoptPersonalBrowserAccessGrant, CONTROL_CLAIM_TTL_MS, releaseSessionControl, type CloudBrowserConnectionProbeDeps } from "@nessie/browser-cloud";
import type { CredentialStore } from "@nessie/dashboard";
import { enqueueOrchestrateDecide } from "@nessie/db";
import { issueExecutorAccessChangeConfirmationToken } from "@nessie/executor-manage";
import { createPgSecretStore } from "@nessie/mcp-manage";
import {
  type AgentCardRespondResult,
  type AuthorizedActionContext,
  AgentCardSpecSchema,
  detectSecrets,
} from "@nessie/schemas";
import type { ReplyRootMetadata } from "@nessie/runtime";
import {
  createSystemAuthoredReply,
  inheritAgentCardResponseBasis,
} from "@nessie/team-admin";
import { toInputJson } from "../db/prisma-json.js";
import {
  AgentCardResumeStateSchema,
  AgentCardValueError,
  buildCardOrchestrationPayload,
  buildResponseContent,
  buildResponseMetadata,
  readBrowserLoginHandoff,
  readTemporaryBrowserLogin,
  validateSubmission,
  type LoadedAgentCard,
} from "./agent-cards.js";
import {
  AgentCardSecretPlacementError,
  resolveAgentCardSecretPlacements,
  rollbackAgentCardSecretPlacements,
  storeAgentCardSecrets,
  type AgentCardSecretPlacements,
} from "./agent-card-secret-placement.js";
import { announceAgentCardResponse } from "./agent-card-response-announce.js";
import { completeBrowserLoginHandover } from "./browser-login-handover.js";
import { ResumeRollback, resumeSuspendedRun } from "./run-resume-core.js";
import type { RouteDeps } from "../routes/types.js";
type ResponseDeps = Pick<
  RouteDeps,
  | "encryptionKeyRing"
  | "buildChannelRealtimeScopes"
  | "mcpSecretStore"
  | "messageMemoryCaptureConfig"
  | "prisma"
  | "realtimeHub"
> & {
  browserCloudClientFactory?: CloudBrowserConnectionProbeDeps["clientFactory"];
  dashboardCredentials: CredentialStore;
};
export class AgentCardResponseError extends Error {
  constructor(
    readonly httpStatus: 403 | 404 | 409 | 422 | 502 | 503,
    readonly code: string,
    message: string,
    readonly fieldKeys?: string[],
  ) {
    super(message);
    this.name = "AgentCardResponseError";
  }
}
type PreparedResponse = {
  card: LoadedAgentCard;
  actionKey: string;
  content: string;
  secretPlacements: AgentCardSecretPlacements;
  secretKeys: string[];
  values: Record<string, string | number | boolean>;
};
const storeBrowserConnectionSecret = (deps: ResponseDeps) =>
  async (tx: Prisma.TransactionClient, apiKey: string): Promise<string> =>
    createPgSecretStore(tx, deps.encryptionKeyRing, {
      purpose: "browser.connection",
      refPrefix: "secret_browserbase_",
    }).put({ accessToken: apiKey });
const prepareResponse = async (
  deps: ResponseDeps,
  input: {
    actionKey: string;
    card: LoadedAgentCard;
    isOwner: boolean;
    secrets: Record<string, string>;
    userId: string;
    values: Record<string, unknown>;
  },
): Promise<PreparedResponse> => {
  const { card } = input;
  if (
    card.respondentUserIds.length > 0 &&
    !card.respondentUserIds.includes(input.userId)
  ) {
    throw new AgentCardResponseError(
      403,
      "CARD_NOT_RESPONDENT",
      "This card is waiting for somebody else to answer it.",
    );
  }
  const spec = AgentCardSpecSchema.safeParse(card.spec);
  if (!spec.success)
    throw new AgentCardResponseError(
      409,
      "CARD_NOT_OPEN",
      "This card can no longer be answered.",
    );
  let submission;
  try {
    submission = validateSubmission({
      actionKey: input.actionKey,
      secrets: input.secrets,
      spec: spec.data,
      values: input.values,
    });
  } catch (error) {
    if (error instanceof AgentCardValueError) {
      throw new AgentCardResponseError(
        422,
        "CARD_INVALID_VALUES",
        error.message,
        error.fieldKeys,
      );
    }
    throw error;
  }
  const intercepted = Object.entries(submission.values).find(
    ([, value]) => typeof value === "string" && detectSecrets(value).length > 0,
  );
  if (intercepted) {
    throw new AgentCardResponseError(
      422,
      "SECRET_INTERCEPTED",
      "A possible credential was intercepted before this card was answered. Save it through Secrets instead.",
      [intercepted[0]],
    );
  }
  try {
    const secretPlacements = await resolveAgentCardSecretPlacements(
      deps.prisma,
      {
        browserCloud: {
          ...(deps.browserCloudClientFactory
            ? { clientFactory: deps.browserCloudClientFactory }
            : {}),
          storeSecret: storeBrowserConnectionSecret(deps),
        },
        isOwner: input.isOwner,
        organizationId: card.organizationId,
        secrets: submission.secrets,
        spec: spec.data,
        userId: input.userId,
      },
    );
    return {
      actionKey: input.actionKey,
      card,
      content: buildResponseContent({
        actionKey: input.actionKey,
        secretKeys: Object.keys(submission.secrets),
        spec: spec.data,
        values: submission.values,
      }),
      secretKeys: Object.keys(submission.secrets),
      secretPlacements,
      values: submission.values,
    };
  } catch (error) {
    if (error instanceof AgentCardSecretPlacementError)
      throw new AgentCardResponseError(
        error.httpStatus,
        error.code,
        error.message,
      );
    throw error;
  }
};

/**
 * The review an executor review card opens, minted for the presser inside the
 * press's transaction. The card holds only the change's id; the token exists
 * from here on in the presser's response alone. A change that is no longer
 * this person's to review refuses the press, so the card stays open rather
 * than resolving into a review that cannot confirm.
 */
const issueExecutorReview = async (
  tx: Prisma.TransactionClient,
  card: LoadedAgentCard,
  userId: string,
): Promise<AgentCardRespondResult["executorReview"]> => {
  if (!card.executorAccessChangeId) return undefined;
  const confirmationToken = await issueExecutorAccessChangeConfirmationToken(tx, {
    accessChangeId: card.executorAccessChangeId,
    actorUserId: userId,
    organizationId: card.organizationId,
  });
  if (!confirmationToken) {
    throw new AgentCardResponseError(
      409,
      "EXECUTOR_ACCESS_CHANGE_STALE",
      "This change is no longer waiting for your review. Ask for it again.",
    );
  }
  return { accessChangeId: card.executorAccessChangeId, confirmationToken };
};

export const respondToAgentCard = async (
  deps: ResponseDeps,
  input: {
    actionKey: string;
    card: LoadedAgentCard;
    actorContext: AuthorizedActionContext;
    handoverSessionId?: string;
    secrets?: Record<string, string>;
    values?: Record<string, unknown>;
  },
): Promise<AgentCardRespondResult> => {
  const userId = input.actorContext.actor.actorId;
  const prepared = await prepareResponse(deps, {
    actionKey: input.actionKey,
    card: input.card,
    isOwner: input.actorContext.actor.roles?.includes("owner") ?? false,
    secrets: input.secrets ?? {},
    userId,
    values: input.values ?? {},
  });
  let outcome: {
    executorReview: AgentCardRespondResult["executorReview"];
    responseMessageId: string;
    responseRestricted: boolean;
    rootMessageId: string;
    replyMetadata: ReplyRootMetadata | null;
    secretOutcomes: Record<string, unknown>;
  };
  try {
    outcome = await deps.prisma.$transaction(async (tx) => {
      const claimed = await tx.agentCard.updateMany({
        data: {
          resolutionValues: toInputJson(prepared.values),
          resolvedActionKey: prepared.actionKey,
          resolvedAt: new Date(),
          resolvedByUserId: userId,
          status: "resolved",
        },
        where: {
          id: prepared.card.id,
          status: "open",
          ...(prepared.card.expiresAt ? { expiresAt: { gt: new Date() } } : {}),
        },
      });
      if (claimed.count !== 1) throw new ResumeRollback("run_not_waiting");
      const executorReview = await issueExecutorReview(tx, prepared.card, userId);
      const temporaryLogin = readTemporaryBrowserLogin(prepared.card.browserLogin);
      if (temporaryLogin) {
        // A temporary-login card cannot resume a run until its exact private
        // session is still under this respondent's fresh human claim. Both
        // release and adoption run in the card's conditional transaction.
        const freshGrantSession = input.handoverSessionId
          ? await tx.browserPersonalAccessGrant.findFirst({
            where: {
              id: temporaryLogin.grantId,
              sessionId: input.handoverSessionId,
              status: 'active',
              expiresAt: { gt: new Date() },
              userId,
              session: {
                controlledByUserId: userId,
                controlClaimedAt: { gt: new Date(Date.now() - CONTROL_CLAIM_TTL_MS) },
                status: 'active',
              },
            },
            select: { id: true },
          })
          : null
        if (!prepared.card.waitRunId
          || !freshGrantSession
          || !(await releaseSessionControl(tx, {
            sessionId: input.handoverSessionId!,
            userId,
          }))) throw new ResumeRollback("run_not_waiting");
      }
      const handoff = readBrowserLoginHandoff(prepared.card.browserLogin);
      if (handoff) {
        const completed = await completeBrowserLoginHandover(tx, {
          agentBrowserId: handoff.agentBrowserId,
          organizationId: prepared.card.organizationId,
          requestedByUserId: userId,
          ...(input.handoverSessionId
            ? { sessionId: input.handoverSessionId }
            : {}),
          threadId: prepared.card.threadId,
          userId,
        });
        // Viewer Done must still own the human control claim. Rolling back the
        // CAS makes a concurrent card press or expired control claim harmless.
        if (input.handoverSessionId && !completed.released)
          throw new ResumeRollback("run_not_waiting");
        await tx.agentBrowserLogin.create({
          data: {
            agentBrowserId: handoff.agentBrowserId,
            organizationId: prepared.card.organizationId,
            serviceHint: handoff.service,
            userId,
          },
        });
      }
      const secretOutcomes = await storeAgentCardSecrets(tx, {
        browserCloud: {
          storeSecret: storeBrowserConnectionSecret(deps),
        },
        dashboardCredentials: deps.dashboardCredentials,
        mcpSecretStore: deps.mcpSecretStore,
        organizationId: prepared.card.organizationId,
        placements: prepared.secretPlacements,
        threadId: prepared.card.threadId,
        userId,
      });
      const rootMessageId =
        prepared.card.message.rootMessageId ?? prepared.card.messageId;
      const { message, replyMetadata } = await createSystemAuthoredReply(tx, {
        authorId: userId,
        content: prepared.content,
        followedByUserIds: [userId],
        metadata: buildResponseMetadata({
          actionKey: prepared.actionKey,
          cardId: prepared.card.id,
        }),
        role: "user",
        rootMessageId,
        threadId: prepared.card.threadId,
        userId,
      });
      await inheritAgentCardResponseBasis(tx, {
        organizationId: prepared.card.organizationId,
        responseMessageId: message.id,
        sourceBasis: prepared.card.message.basisScopes,
      });
      await tx.agentCard.update({
        data: {
          responseMessageId: message.id,
          ...(Object.keys(secretOutcomes).length
            ? { secretOutcomes: secretOutcomes as Prisma.InputJsonValue }
            : {}),
        },
        where: { id: prepared.card.id },
      });
      if (prepared.card.waitRunId) {
        const resumeState = AgentCardResumeStateSchema.safeParse(
          prepared.card.resumeState,
        );
        if (resumeState.success) {
          const resumed = await resumeSuspendedRun(tx, {
            eventPayload: { fromCardId: prepared.card.id },
            interactive: resumeState.data.interactive,
            organizationId: prepared.card.organizationId,
            queueKeyPrefix: "run:card",
            resumeActorContext: resumeState.data.actorContext,
            runId: prepared.card.waitRunId,
            suspendedStatus: "waiting_input",
            triggerMessageId: resumeState.data.messageId,
          });
          // `resumeSuspendedRun` always creates a successor. The temporary
          // grant is one task's consent, not a permission for its terminal
          // parked row, so bind it to that exact successor only after the
          // card's one-shot resume proved the old→new continuation edge.
          if (temporaryLogin && !(await adoptPersonalBrowserAccessGrant(tx, {
            expectedOriginalRunId: prepared.card.waitRunId,
            grantId: temporaryLogin.grantId,
            runId: resumed.runId,
            threadId: prepared.card.threadId,
            userId,
          }))) throw new ResumeRollback("run_not_waiting");
          await tx.agentCard.update({
            data: { resumedByRunId: resumed.runId },
            where: { id: prepared.card.id },
          });
          return {
            executorReview,
            replyMetadata,
            responseMessageId: message.id,
            responseRestricted: prepared.card.message.basisScopes.length > 0,
            rootMessageId,
            secretOutcomes,
          };
        }
      }
      // A review card's press is not an answer to its agent: it opens a review
      // only this person can finish, so there is nothing for the agent to say
      // and waking it would only have it repeat "confirm it there".
      if (!executorReview) {
        await enqueueOrchestrateDecide(
          tx,
          buildCardOrchestrationPayload({
            actorContext: input.actorContext,
            agent: prepared.card.agent,
            channelId: prepared.card.channelId,
            content: prepared.content,
            messageId: message.id,
            threadId: prepared.card.threadId,
          }),
          `orchestrate:card:${prepared.card.id}`,
        );
      }
      return {
        executorReview,
        replyMetadata,
        responseMessageId: message.id,
        responseRestricted: prepared.card.message.basisScopes.length > 0,
        rootMessageId,
        secretOutcomes,
      };
    });
  } catch (error) {
    await rollbackAgentCardSecretPlacements(prepared.secretPlacements);
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    )
      throw new AgentCardResponseError(
        409,
        "SECRET_NAME_TAKEN",
        "A secret with that name already exists in this scope. Rename or replace it in Secrets.",
      );
    if (error instanceof ResumeRollback)
      throw new AgentCardResponseError(
        409,
        "CARD_NOT_OPEN",
        "This card has already been answered or is no longer open.",
      );
    throw error;
  }
  // Committed: the card is resolved, its reply written, its run resumed. What
  // follows only announces that, so it can fail without failing the press.
  await announceAgentCardResponse(deps, {
    actionKey: prepared.actionKey,
    actorContext: input.actorContext,
    card: prepared.card,
    content: prepared.content,
    responseMessageId: outcome.responseMessageId,
    responseRestricted: outcome.responseRestricted,
    rootMessageId: outcome.rootMessageId,
    secretKeys: prepared.secretKeys,
    secretOutcomes: outcome.secretOutcomes,
    userId,
    valueKeys: Object.keys(prepared.values),
  });
  return {
    cardId: prepared.card.id,
    ...(outcome.executorReview ? { executorReview: outcome.executorReview } : {}),
    responseMessageId: outcome.responseMessageId,
    status: "resolved",
  };
};
