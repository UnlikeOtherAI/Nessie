import { ExecutorError } from '@nessie/executor-manage'
import type { FastifyReply } from 'fastify'

import { sendApiError } from '../lib/api.js'

export const sendExecutorError = (reply: FastifyReply, error: unknown): boolean => {
  if (!(error instanceof ExecutorError)) return false
  const status = error.code === 'EXECUTOR_NOT_FOUND'
    || error.code === 'EXECUTOR_ACCESS_CHANGE_NOT_FOUND'
    || error.code === 'EXECUTOR_PROMOTION_NOT_FOUND'
    || error.code === 'EXECUTOR_PROMOTION_REVIEW_NOT_FOUND'
    ? 404
    : error.code === 'SCOPE_ENTITLEMENT_DENIED'
      ? 403
      : error.code === 'EXECUTOR_DAEMON_PROOF_INVALID'
          || error.code === 'EXECUTOR_DAEMON_CHALLENGE_INVALID'
        ? 401
        : error.code === 'EXECUTOR_FRESH_VERIFICATION_REQUIRED'
          ? 401
          : error.code === 'EXECUTOR_STATE_TRANSITION_INVALID'
            || error.code === 'EXECUTOR_PRIVATE_FINAL_ADMIN_REQUIRED'
            || error.code === 'EXECUTOR_ACCESS_CHANGE_STALE'
            || error.code === 'EXECUTOR_ACCESS_CHANGE_EXPIRED'
            || error.code === 'EXECUTOR_CONNECTION_FENCED'
            || error.code === 'EXECUTOR_HEARTBEAT_STALE'
            || error.code === 'EXECUTOR_DESCRIPTOR_REVISION_CONFLICT'
            || error.code === 'EXECUTOR_DESCRIPTOR_ROLLBACK'
            || error.code === 'EXECUTOR_COMMAND_REPLAY'
            || error.code === 'EXECUTOR_PROMOTION_STALE'
            || error.code === 'EXECUTOR_PROMOTION_UNAVAILABLE'
          ? 409
          : 400
  sendApiError(reply, status, error.code, error.message)
  return true
}
