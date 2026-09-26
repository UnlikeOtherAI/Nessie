import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { SecretRecord as SharedSecretRecord, SecretScopeType } from '@nessie/schemas'

import { secretKeys } from './keys'
import { useApiClient } from '../../providers/ApiClientProvider'

export type { SecretScopeType }

// The server-enforced shape (`SecretRecordSchema`, parsed on every response
// in `api/src/routes/secrets.ts`) rather than a hand-copied type, so a field
// the server adds or renames cannot silently drift from what this client
// reads.
export type SecretRecord = SharedSecretRecord

export type CreateSecretInput = {
  name: string
  value: string
  description?: string
  provider?: string
  scopeType: SecretScopeType
  scopeId?: string
  locked?: boolean
}

/** `enabled` lets a summary skip the read for a viewer it shows no keys to. */
export const useSecrets = (enabled = true) => {
  const apiClient = useApiClient()
  return useQuery<SecretRecord[]>({
    enabled,
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
