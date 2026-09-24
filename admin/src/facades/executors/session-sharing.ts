import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ExecutorHostSessionListSchema, ExecutorSessionSharesSchema } from '@nessie/schemas'

import { useApiClient } from '../../providers/ApiClientProvider'
import { executorKeys } from './keys'

export const useExecutorHostSessions = (executorId?: string) => {
  const api = useApiClient()
  return useQuery({
    queryKey: executorKeys.hostSessions(executorId), gcTime: 0,
    // Switching machines keeps the last list on screen until the next one answers.
    placeholderData: keepPreviousData,
    queryFn: () => api.get('/api/executor-sessions' + (executorId ? '?executorId=' + executorId : ''),
      ExecutorHostSessionListSchema),
    refetchInterval: 15_000,
  })
}

export const useExecutorSessionSharing = (executorId: string, sessionId: string, enabled: boolean) => {
  const api = useApiClient()
  const cache = useQueryClient()
  const path = `/api/executors/${executorId}/coding-sessions/${sessionId}/shares`
  const queryKey = executorKeys.sessionShares(executorId, sessionId)
  const query = useQuery({
    queryKey, enabled, gcTime: 0, queryFn: () => api.get(path, ExecutorSessionSharesSchema),
  })
  const change = useMutation({
    mutationFn: (input: { email: string } | { userId: string }) => 'email' in input
      ? api.post(path, input) : api.delete(path + '/' + input.userId),
    onSuccess: () => cache.invalidateQueries({ queryKey }),
  })
  return { query, change }
}
