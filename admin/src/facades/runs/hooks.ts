import { useMutation, useQueryClient } from '@tanstack/react-query'
import { runKeys } from '../../lib/query-keys'
import { useApiClient } from '../../providers/ApiClientProvider'

// Cancel/continue invalidate the active-run list so a run's state refreshes
// wherever it is shown (the document-stream cancel control, budget-stop
// Continue notices).
export const useCancelRun = () => {
  const apiClient = useApiClient()
  const queryClient = useQueryClient()
  return useMutation<{ status: 'cancelled' | 'cancel_requested' }, Error, string>({
    mutationFn: (runId) => apiClient.post(`/api/runs/${runId}/cancel`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: runKeys.active })
    },
  })
}

// Resume a run that stopped at a policy ceiling from its saved working state.
// The API refuses with a 409 whose message names the reason (already continued,
// agent busy, handoff-managed); callers surface that message verbatim rather
// than re-deriving meaning on the client.
export const useContinueRun = () => {
  const apiClient = useApiClient()
  const queryClient = useQueryClient()
  return useMutation<{ runId: string }, Error, string>({
    mutationFn: (runId) => apiClient.post(`/api/runs/${runId}/continue`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: runKeys.active })
    },
  })
}
