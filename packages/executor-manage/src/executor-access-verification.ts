import { createHash } from 'node:crypto'
import type { PrismaClient } from '@prisma/client'
import type { AuthorizedActionContext } from '@nessie/schemas'
import { ExecutorError, EXECUTOR_ERROR_CODES } from './executor-errors.js'
import { executorContinuationValuesMatch, hashExecutorContinuationValue } from './executor-continuation-security.js'

/** Bind external fresh authentication to the exact immutable prepared change. */
export const executorAccessVerificationBinding = async (
  prisma: PrismaClient, actor: AuthorizedActionContext,
  input: { accessChangeId: string; confirmationToken: string },
): Promise<{ actionDigest: string; executorId: string }> => {
  const row = await prisma.executorContinuation.findFirst({ where: {
    id: input.accessChangeId, actorUserId: actor.actor.actorId,
    executor: { organizationId: actor.tenant.organizationId },
  } })
  if (!row || !executorContinuationValuesMatch(
    hashExecutorContinuationValue(input.confirmationToken), row.confirmationTokenHash,
  )) throw new ExecutorError(EXECUTOR_ERROR_CODES.ACCESS_CHANGE_NOT_FOUND, 'Access change not found.')
  if (row.status !== 'pending' || row.expiresAt <= new Date() || !row.verificationChallengeId) {
    throw new ExecutorError(EXECUTOR_ERROR_CODES.ACCESS_CHANGE_STALE, 'Reopen this change to verify it again.')
  }
  return {
    executorId: row.executorId,
    actionDigest: createHash('sha256').update(JSON.stringify([
      'nessie.executor-access.v1', row.id, row.actorUserId, row.executorId,
      row.verificationChallengeId, row.subjectDigest,
    ])).digest('hex'),
  }
}
