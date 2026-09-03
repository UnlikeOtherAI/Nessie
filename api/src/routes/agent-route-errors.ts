import { sendApiError } from '../lib/api.js'
import {
  AGENT_MANAGEMENT_ERROR_CODES,
  AgentManagementError,
} from '../services/agents.js'
import { AgentEditAuthorityError } from '../services/agent-management.js'
import { LedgerAgentModelCatalogError } from '@nessie/team-admin'
import {
  AGENT_TOOL_POLICY_ERROR_CODES,
  AgentToolPolicyError,
} from '../services/agent-tool-policy.js'
import { AgentAvatarGenerationError } from '../services/agent-avatar-generation.js'

export const sendAgentAvatarGenerationError = (
  reply: Parameters<typeof sendApiError>[0],
  error: unknown,
): boolean => {
  if (!(error instanceof AgentAvatarGenerationError)) return false
  sendApiError(reply, 503, 'AGENT_AVATAR_GENERATION_UNAVAILABLE', error.message)
  return true
}

/**
 * An edit refusal is a 403, not a 404: the caller has already been shown this
 * agent by the entitlement check, so hiding it now would only be confusing. The
 * refusal names the state — who owns it, or that nobody may edit a
 * blueprint-managed agent — so the person knows what to ask for.
 */
export const sendAgentEditAuthorityError = (
  reply: Parameters<typeof sendApiError>[0],
  error: unknown,
): boolean => {
  if (!(error instanceof AgentEditAuthorityError)) return false
  sendApiError(reply, 403, error.code, error.message)
  return true
}

export const sendProtectedPolicyError = (
  reply: Parameters<typeof sendApiError>[0],
  error: unknown,
) => {
  if (
    error instanceof AgentToolPolicyError
    && error.code === AGENT_TOOL_POLICY_ERROR_CODES.PROTECTED_INPUT
  ) {
    sendApiError(reply, 400, error.code, error.message)
    return true
  }
  return false
}

export const sendAgentManagementError = (
  reply: Parameters<typeof sendApiError>[0],
  error: unknown,
): boolean => {
  if (
    error instanceof AgentManagementError
    && error.code === AGENT_MANAGEMENT_ERROR_CODES.PARENT_NOT_FOUND
  ) {
    sendApiError(reply, 404, error.code, error.message)
    return true
  }
  if (
    error instanceof AgentManagementError
    && error.code === AGENT_MANAGEMENT_ERROR_CODES.PRIVATE_TRANSFER_UNSUPPORTED
  ) {
    sendApiError(reply, 400, error.code, error.message)
    return true
  }
  if (
    error instanceof AgentManagementError
    && error.code === AGENT_MANAGEMENT_ERROR_CODES.TODOS_IN_USE
  ) {
    sendApiError(reply, 409, error.code, error.message)
    return true
  }
  return false
}

export const sendAgentModelCatalogError = (
  reply: Parameters<typeof sendApiError>[0],
  error: unknown,
): boolean => {
  if (!(error instanceof LedgerAgentModelCatalogError)) {
    return false
  }

  const status = error.code === 'LEDGER_AGENT_MODEL_NOT_AVAILABLE' ? 400 : 503
  sendApiError(reply, status, error.code, error.message)
  return true
}
