import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useApiClient } from '../../providers/ApiClientProvider'

export type ActiveRunSummary = {
  id: string
  agentId: string
  agentName: string
  threadId: string
  channelId: string
  status: 'pending' | 'running' | 'waiting_approval'
  startedAt: string | null
  createdAt: string
  cancelRequested: boolean
  toolCallCount: number
}

export type RestartableRunSummary = {
  id: string
  agentId: string
  agentName: string
  threadId: string
  channelId: string
  status: 'failed' | 'cancelled'
  finishedAt: string | null
  createdAt: string
  toolCallCount: number
}

export const activeRunsKey = ['runs', 'active'] as const

// Org-scoped read of every live run plus recently-ended restartable runs — the
// "what is running / what can I stop / what can I re-run" status surface. Polled
// so cancel/restart effects and worker-driven terminal transitions show up
// without a manual refresh.
export const useActiveRuns = () => {
  const apiClient = useApiClient()
  return useQuery<{ runs: ActiveRunSummary[]; restartable: RestartableRunSummary[] }>({
    queryKey: activeRunsKey,
    queryFn: () => apiClient.get('/api/runs/active'),
    refetchInterval: 5000,
  })
}

export const useCancelRun = () => {
  const apiClient = useApiClient()
  const queryClient = useQueryClient()
  return useMutation<{ status: 'cancelled' | 'cancel_requested' }, Error, string>({
    mutationFn: (runId) => apiClient.post(`/api/runs/${runId}/cancel`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: activeRunsKey })
    },
  })
}

export const useRestartRun = () => {
  const apiClient = useApiClient()
  const queryClient = useQueryClient()
  return useMutation<{ run: { id: string; status: string } }, Error, string>({
    mutationFn: (runId) => apiClient.post(`/api/runs/${runId}/restart`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: activeRunsKey })
    },
  })
}
