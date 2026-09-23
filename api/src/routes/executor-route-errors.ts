import { EXECUTOR_ATTACHMENT_RATE_WINDOW_MS, ExecutorError } from '@nessie/executor-manage'
import type { FastifyReply } from 'fastify'

import { sendApiError } from '../lib/api.js'

export const sendExecutorError = (reply: FastifyReply, error: unknown): boolean => {
  if (!(error instanceof ExecutorError)) return false
  // A daemon retries a 429 on its next poll and gives an image up on any other
  // 4xx (docs/executor-protocol/command-attachments.md), so the rate is the
  // one attachment answer that must not be a plain refusal.
  if (error.code === 'EXECUTOR_COMMAND_ATTACHMENT_RATE_LIMITED') {
    reply.header('retry-after', String(EXECUTOR_ATTACHMENT_RATE_WINDOW_MS / 1000))
    sendApiError(reply, 429, error.code, error.message)
    return true
  }
  const status = error.code === 'EXECUTOR_NOT_FOUND'
    || error.code === 'EXECUTOR_CODING_SESSION_NOT_FOUND'
    || error.code === 'EXECUTOR_ACCESS_CHANGE_NOT_FOUND'
    || error.code === 'EXECUTOR_PROMOTION_NOT_FOUND'
    || error.code === 'EXECUTOR_PROMOTION_REVIEW_NOT_FOUND'
    ? 404
    : error.code === 'SCOPE_ENTITLEMENT_DENIED' || error.code === 'EXECUTOR_CODING_SESSIONS_OWNER_ONLY'
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
            || error.code === 'EXECUTOR_COMMAND_ATTACHMENT_REFUSED'
            || error.code === 'EXECUTOR_PROMOTION_STALE'
            || error.code === 'EXECUTOR_PROMOTION_UNAVAILABLE'
          ? 409
          : 400
  sendApiError(reply, status, error.code, error.message)
  return true
}
