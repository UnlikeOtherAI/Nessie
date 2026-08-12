import { sendApiError } from '../lib/api.js'
import {
  AGENT_MANAGEMENT_ERROR_CODES,
  AgentManagementError,
} from '../services/agents.js'
import { LedgerAgentModelCatalogError } from '@nessie/workspace-admin'
import {
  AGENT_TOOL_POLICY_ERROR_CODES,
  AgentToolPolicyError,
} from '../services/agent-tool-policy.js'

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
