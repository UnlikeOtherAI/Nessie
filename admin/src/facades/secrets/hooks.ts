import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import { secretKeys } from '../../lib/query-keys'
import { useApiClient } from '../../providers/ApiClientProvider'

export type SecretScopeType = 'personal' | 'team' | 'project' | 'organization'

export type SecretRecord = {
  reference: string
  name: string
  description: string | null
  provider: string | null
  scopeType: SecretScopeType
  scopeId: string
  rotatedAt: string | null
  expiresAt: string | null
  status: 'active' | 'revoked' | 'expired'
  createdAt: string
  updatedAt: string
}

export type CreateSecretInput = {
  name: string
  value: string
  description?: string
  provider?: string
  scopeType: SecretScopeType
  scopeId?: string
}

export const useSecrets = () => {
  const apiClient = useApiClient()
  return useQuery<SecretRecord[]>({
    queryKey: secretKeys.all,
    queryFn: () => apiClient.get('/api/secrets'),
  })
}

export const useCreateSecret = () => {
  const apiClient = useApiClient()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: CreateSecretInput) => apiClient.post<SecretRecord>('/api/secrets', input),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: secretKeys.all }),
  })
}

export const useRevokeSecret = () => {
  const apiClient = useApiClient()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (reference: string) => apiClient.post<SecretRecord>(`/api/secrets/${reference}/revoke`, {}),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: secretKeys.all }),
  })
}
