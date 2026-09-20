import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useApiClient } from '../../providers/ApiClientProvider'
import { localInferenceKeys } from './keys'

export type LocalInferenceHost = {
  availability: 'online' | 'offline' | 'unknown'
  id: string
  lastSeenAt: string | null
  models: Array<{ manifestDigest: string; name: string }>
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
      apiClient.post(`/api/local-inference/hosts/${input.hostId}/${input.action}`),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: localInferenceKeys.all }),
  })
}
