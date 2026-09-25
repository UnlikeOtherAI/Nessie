import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ExecutorSharingViewSchema, type ExecutorSharingChange } from '@nessie/schemas'
import { useApiClient } from '../../providers/ApiClientProvider'
import { executorKeys } from './keys'

export const useExecutorSharing = (executorId: string, teamId?: string) => {
  const client = useApiClient()
  return useQuery({
    queryKey: executorKeys.sharing(executorId, teamId), enabled: Boolean(teamId),
    queryFn: () => client.get(`/api/executors/${executorId}/sharing?teamId=${teamId}`, ExecutorSharingViewSchema),
  })
}

export const useUpdateExecutorSharing = () => {
  const client = useApiClient()
  const cache = useQueryClient()
  return useMutation({
    mutationFn: ({ executorId, ...body }: { executorId: string; teamId: string; change: ExecutorSharingChange }) =>
      client.put(`/api/executors/${executorId}/sharing`, body),
    onSuccess: () => cache.invalidateQueries({ queryKey: executorKeys.all }),
  })
}

export const useSetExecutorAgentAccess = () => {
  const client = useApiClient()
  const cache = useQueryClient()
  return useMutation({
    mutationFn: ({ executorId, change }: {
      executorId: string; change: { agentId: string; state: 'allowed' | 'denied' },
    }) => client.put(`/api/executors/${executorId}/agents`, change),
    onSuccess: () => cache.invalidateQueries({ queryKey: executorKeys.all }),
  })
}
