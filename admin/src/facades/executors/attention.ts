import { ExecutorAttentionSummarySchema } from '@nessie/schemas'
import { useQuery } from '@tanstack/react-query'
import { useApiClient } from '../../providers/ApiClientProvider'
import { executorKeys } from './keys'

/** One caller-scoped answer for the sidebar, list and detail review doorway. */
export const useExecutorAttention = () => {
  const apiClient = useApiClient()
  return useQuery({
    queryKey: executorKeys.attention,
    queryFn: () => apiClient.get('/api/executors/attention', ExecutorAttentionSummarySchema),
    refetchInterval: 30_000,
    refetchOnWindowFocus: true,
    retry: false,
    staleTime: 15_000,
  })
}
