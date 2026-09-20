import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useApiClient } from '../../providers/ApiClientProvider'
import { localInferenceKeys } from './keys'

export type LocalInferenceHost = {
  availability: 'online' | 'offline' | 'unknown'
  executorId: string | null
  id: string
  lastSeenAt: string | null
  models: Array<{ manifestDigest: string; name: string }>
  paused: boolean
  status: 'consented_pending_activation' | 'needs_rebinding' | 'pending' | 'revoked' | 'active' | 'unconfigured'
  transport: 'desktop' | 'executor'
}

type HostList = { hosts: LocalInferenceHost[]; meta: { total: number } }

export const useLocalInferenceHosts = () => {
  const apiClient = useApiClient()
  return useQuery<HostList>({
    queryKey: localInferenceKeys.hosts,
    queryFn: () => apiClient.get('/api/local-inference/hosts'),
    refetchInterval: 30_000,
  })
}

export const useLocalInferenceHostAction = () => {
  const apiClient = useApiClient()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: { action: 'pause' | 'resume' | 'revoke'; hostId: string }) =>
      apiClient.post(`/api/local-inference/hosts/${input.hostId}/${input.action}`, {}),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: localInferenceKeys.all }),
  })
}

/** Registers a native-protected Desktop key. Model discovery still happens only
 * in the direct host daemon after the person has deliberately prepared it. */
export const useEnrollLocalInferenceDesktopHost = () => {
  const apiClient = useApiClient()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: { displayLabel: string; publicKey: string }) =>
      apiClient.post<{ hostId: string; organizationId: string }>('/api/local-inference/hosts/enroll', input),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: localInferenceKeys.all }),
  })
}

export const usePrepareLocalInferenceBinding = () => {
  const apiClient = useApiClient()
  return useMutation({
    mutationFn: (input: { agentId: string; hostId: string; manifestDigest: string; modelName: string }) => {
      const { agentId, ...body } = input
      return apiClient.post<{ bindingId: string; challengeId: string; expiresAt: string }>(
        `/api/agents/${agentId}/local-inference/prepare`, body,
      )
    },
  })
}

export const useConfirmLocalInferenceBinding = () => {
  const apiClient = useApiClient()
  return useMutation({
    mutationFn: (input: { agentId: string; challengeId: string; signature: string }) => {
      const { agentId, ...body } = input
      return apiClient.post<{ bindingId: string }>(`/api/agents/${agentId}/local-inference/confirm`, body)
    },
  })
}
