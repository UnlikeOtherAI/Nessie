import type { Prisma } from '@prisma/client';
import {
  confirmExecutorAccessChangeInTransaction,
  EXECUTOR_ALLOW_ACCESS_CARD_ACTION_KEY,
  ExecutorError, EXECUTOR_ERROR_CODES,
  getExecutorAccessChangeForUser,
  issueExecutorAccessChangeConfirmationToken,
} from '@nessie/executor-manage';
import { applyExecutorAgentPolicyChange } from '@nessie/team-admin';
import type { AuthorizedActionContext } from '@nessie/schemas';
import type { LoadedAgentCard } from './agent-cards.js';

export const isExecutorAccessAnswer = (card: LoadedAgentCard, actionKey: string): boolean =>
  Boolean(card.executorAccessChangeId) && actionKey === EXECUTOR_ALLOW_ACCESS_CARD_ACTION_KEY;

/** Inside the ordinary card response transaction: grant, answer and wake commit together. */
export const applyExecutorAccessAnswer = async (
  tx: Prisma.TransactionClient,
  actorContext: AuthorizedActionContext,
  card: LoadedAgentCard,
): Promise<void> => {
  const accessChangeId = card.executorAccessChangeId;
  if (!accessChangeId) throw new ExecutorError(EXECUTOR_ERROR_CODES.ACCESS_CHANGE_STALE, 'This card has no prepared machine access.');
  const prepared = await getExecutorAccessChangeForUser(tx, actorContext, accessChangeId);
  if (!prepared || prepared.requiresFreshVerification || prepared.change.kind !== 'agent_executor_access'
    || prepared.change.state !== 'allowed') {
    throw new ExecutorError(EXECUTOR_ERROR_CODES.FRESH_VERIFICATION_REQUIRED, 'This change needs a separate machine permission review.');
  }
  const confirmationToken = await issueExecutorAccessChangeConfirmationToken(tx, {
    accessChangeId, actorUserId: actorContext.actor.actorId, organizationId: card.organizationId,
  });
  if (!confirmationToken) throw new ExecutorError(EXECUTOR_ERROR_CODES.ACCESS_CHANGE_STALE, 'This access request has expired or was already answered.');
  await confirmExecutorAccessChangeInTransaction(tx, actorContext, {
    accessChangeId, confirmationToken, freshVerificationSatisfied: false,
  }, (transaction, change) => applyExecutorAgentPolicyChange(transaction, {
    ...change, actorUserId: actorContext.actor.actorId, organizationId: card.organizationId,
  }));
};
