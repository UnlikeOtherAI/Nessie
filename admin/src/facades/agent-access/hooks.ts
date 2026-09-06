import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import { useApiClient } from '../../providers/ApiClientProvider'
import { agentAccessKeys } from './keys'

/**
 * Pairing an agent with your account, and managing what that produced.
 *
 * The credential these mint acts as you. That is the whole point — an agent
 * reaches exactly what you reach — and it is also why this surface exists: a
 * foothold in your account should be something you can see and take back, not
 * something that only lives in a config file on some machine.
 */

export type AgentAccessScope =
  | 'boards_read'
  | 'boards_write'
  | 'documents_read'
  | 'documents_write'

export type PendingAgentAuthorization = {
  clientName: string
  requestedScopes: AgentAccessScope[]
}

export type AgentAccessCredentialRecord = {
  createdAt: string
  expiresAt: string
  id: string
  label: string
  lastUsedAt: string | null
  revokedAt: string | null
  scopes: AgentAccessScope[]
  tokenPrefix: string
}

/**
 * The request behind a pairing code.
 *
 * Only enabled once there is a code to look up: a bare visit to the page is
 * somebody managing their credentials, not approving anything.
 */
export const usePendingAgentAuthorization = (code: string) => {
  const apiClient = useApiClient()
  return useQuery({
    enabled: code.trim().length > 0,
    queryFn: () =>
      apiClient.get<PendingAgentAuthorization>(
        `/api/mcp/agent-access/pending?code=${encodeURIComponent(code.trim())}`,
      ),
    queryKey: agentAccessKeys.pending(code.trim()),
    // A rejected pairing code is a definitive answer, not a blip: retrying it
    // three times only makes the person wait several seconds to be told they
    // mistyped. The credential list beside it keeps the default policy.
    retry: false,
    // A code lasts ten minutes and is single use, so a cached "still pending"
    // is worth nothing once it has been decided.
    staleTime: 0,
  })
}

export const useAgentAccessCredentials = () => {
  const apiClient = useApiClient()
  return useQuery({
    queryFn: () =>
      apiClient.get<{ credentials: AgentAccessCredentialRecord[] }>(
        '/api/mcp/agent-access/credentials',
      ),
    queryKey: agentAccessKeys.credentials,
  })
}

export const useDecideAgentAuthorization = () => {
  const apiClient = useApiClient()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (input: {
      approve: boolean
      scopes: AgentAccessScope[]
      userCode: string
    }) => apiClient.post('/api/mcp/agent-access/decide', input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: agentAccessKeys.credentials })
      void queryClient.invalidateQueries({ queryKey: agentAccessKeys.pendingAll })
    },
  })
}

export const useRevokeAgentAccessCredential = () => {
  const apiClient = useApiClient()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (credentialId: string) =>
      apiClient.post(`/api/mcp/agent-access/credentials/${credentialId}/revoke`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: agentAccessKeys.credentials })
    },
  })
}
