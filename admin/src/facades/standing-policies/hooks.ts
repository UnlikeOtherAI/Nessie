import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type {
  EndStandingPolicyResponse,
  PrepareStandingPolicyBody,
  ExecutorStandingPolicyListResponse,
  PreparedStandingPolicyResponse,
  StandingPolicyMachineOptionsResponse,
  TriggerMachineAccessView,
} from '@nessie/schemas'

import { useApiClient } from '../../providers/ApiClientProvider'
import { executorKeys } from '../executors/keys'
import { triggerKeys } from '../triggers/keys'
import { standingPolicyKeys } from './keys'

/**
 * Standing machine access as the screens read it
 * (docs/standards/ticket-work-machine-access.md → "What the screens show"):
 * a ticket trigger's Machine access section, the author's machines for its
 * setup form, the prepare that answers the one card, an executor's Standing
 * access panel, and End.
 */

/** A live section re-reads while tickets move through the queue. */
const LIVE_POLL_MS = 15_000

export const useTriggerMachineAccess = (triggerId?: string, enabled = true) => {
  const apiClient = useApiClient()
  return useQuery<TriggerMachineAccessView>({
    enabled: enabled && Boolean(triggerId),
    queryFn: () => apiClient.get(`/api/triggers/${triggerId}/machine-access`),
    queryKey: standingPolicyKeys.trigger(triggerId),
    refetchInterval: (query) => (query.state.data?.state === 'live' ? LIVE_POLL_MS : false),
  })
}

export const useStandingPolicyMachines = (triggerId?: string, enabled = true) => {
  const apiClient = useApiClient()
  return useQuery<StandingPolicyMachineOptionsResponse>({
    enabled: enabled && Boolean(triggerId),
    queryFn: () => apiClient.get(`/api/triggers/${triggerId}/machine-access/machines`),
    queryKey: standingPolicyKeys.machines(triggerId),
  })
}

/** The author-only prepare: the one card, and the token its review confirms with. */
export const usePrepareStandingPolicy = (triggerId?: string) => {
  const apiClient = useApiClient()
  const queryClient = useQueryClient()
  return useMutation<PreparedStandingPolicyResponse, Error, PrepareStandingPolicyBody>({
    mutationFn: (body) => apiClient.post(`/api/triggers/${triggerId}/machine-access`, body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: standingPolicyKeys.trigger(triggerId) })
    },
  })
}

export const useExecutorStandingPolicies = (executorId?: string, enabled = true) => {
  const apiClient = useApiClient()
  return useQuery<ExecutorStandingPolicyListResponse>({
    enabled: enabled && Boolean(executorId),
    queryFn: () => apiClient.get(`/api/executors/${executorId}/standing-policies`),
    queryKey: standingPolicyKeys.executor(executorId),
  })
}

/** End: every standing read, the trigger's deliveries and the machine's sessions move with it. */
export const useEndStandingPolicy = () => {
  const apiClient = useApiClient()
  const queryClient = useQueryClient()
  return useMutation<EndStandingPolicyResponse, Error, { policyId: string; executorId?: string }>({
    mutationFn: ({ policyId }) => apiClient.post(`/api/standing-policies/${policyId}/end`, {}),
    onSuccess: (_result, { executorId }) => {
      void queryClient.invalidateQueries({ queryKey: standingPolicyKeys.all })
      void queryClient.invalidateQueries({ queryKey: triggerKeys.all })
      if (executorId) void queryClient.invalidateQueries({ queryKey: executorKeys.codingSessions(executorId) })
    },
  })
}
