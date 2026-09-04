import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback } from 'react'

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

/**
 * Secure-capture values must not enter TanStack's application-wide mutation
 * cache. This direct request retains the raw value only for the lifetime of
 * the awaited vault POST, then invalidates the ordinary metadata query.
 */
export const useTransientSecretSave = () => {
  const apiClient = useApiClient()
  const queryClient = useQueryClient()
  return useCallback(async (
    input: CreateSecretInput,
    idempotencyKey: string,
  ): Promise<SecretRecord> => {
    const secret = await apiClient.post<SecretRecord>(
      '/api/secrets',
      input,
      { 'Idempotency-Key': idempotencyKey },
    )
    void queryClient.invalidateQueries({ queryKey: secretKeys.all })
    return secret
  }, [apiClient, queryClient])
}

export const useRevokeSecret = () => {
  const apiClient = useApiClient()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (reference: string) => apiClient.post<SecretRecord>(`/api/secrets/${reference}/revoke`, {}),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: secretKeys.all }),
  })
}
