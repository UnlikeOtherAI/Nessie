import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  ExecutorPairingClaimRequestSchema,
  ExecutorPairingClaimResponseSchema,
  ExecutorPairingOptionsSchema,
  ExecutorPairingPreviewSchema,
  ExecutorRecordResponseSchema,
  type ExecutorPairingClaimRequest,
} from '@nessie/schemas'
import { useApiClient } from '../../providers/ApiClientProvider'
import { executorKeys } from './keys'

export const useExecutorPairingOptions = (enabled: boolean) => {
  const client = useApiClient()
  return useQuery({
    enabled,
    queryKey: executorKeys.pairingOptions,
    queryFn: () => client.get('/api/executor-pairing/options', ExecutorPairingOptionsSchema),
    staleTime: 0,
  })
}

// Codes are transient form input, never query keys, URLs or persisted state.
export const usePreviewExecutorPairing = () => {
  const client = useApiClient()
  return useMutation({
    gcTime: 0,
    mutationFn: (code: string) => client.post(
      '/api/executor-pairing/preview', { code }, undefined, ExecutorPairingPreviewSchema,
    ),
  })
}

export const useClaimExecutorPairing = () => {
  const client = useApiClient()
  const queryClient = useQueryClient()
  return useMutation({
    gcTime: 0,
    mutationFn: (input: ExecutorPairingClaimRequest) => client.post(
      '/api/executor-pairing/claim', ExecutorPairingClaimRequestSchema.parse(input),
      undefined, ExecutorPairingClaimResponseSchema,
    ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: executorKeys.all })
    },
  })
}

export const useExecutorPairingStatus = (executorId: string | null) => {
  const client = useApiClient()
  return useQuery({
    enabled: executorId !== null,
    queryKey: executorKeys.pairingStatus(executorId),
    // A previous machine's consent must never mark a fresh attempt as paired.
    placeholderData: undefined,
    queryFn: () => client.get(`/api/executors/${executorId}`, ExecutorRecordResponseSchema),
    refetchInterval: (query) => query.state.data?.status === 'pending_pairing' ? 3_000 : false,
    retry: false,
  })
}
