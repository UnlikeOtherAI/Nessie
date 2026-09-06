import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import { workflowKeys } from '../workflows/keys'
import { demonstrationKeys } from './keys'
import { useApiClient } from '../../providers/ApiClientProvider'

export type DemonstrationRecord = {
  agentId: string
  capturedAt: string | null
  channelId: string
  expiresAt: string
  generalizationError?: string | null
  id: string
  organizationId: string
  startedAt: string
  startedByUserId: string
  status: 'recording' | 'captured' | 'generalized' | 'discarded'
  stepCount: number
  threadId: string
  workflowTemplateId?: string | null
}

const invalidateDemonstrations = (queryClient: ReturnType<typeof useQueryClient>) => {
  void queryClient.invalidateQueries({ queryKey: demonstrationKeys.all })
}

export const useDemonstrations = () => {
  const apiClient = useApiClient()
  return useQuery<DemonstrationRecord[]>({
    queryKey: demonstrationKeys.all,
    queryFn: () => apiClient.get('/api/demonstrations'),
    refetchInterval: 4_000,
  })
}

export const useActiveDemonstrations = (channelId?: string) => {
  const apiClient = useApiClient()
  return useQuery<DemonstrationRecord[]>({
    placeholderData: keepPreviousData,
    queryKey: demonstrationKeys.active(channelId),
    queryFn: () => apiClient.get(`/api/demonstrations/active/${channelId}`),
    enabled: Boolean(channelId),
    refetchInterval: 4_000,
  })
}

export const useStartDemonstration = () => {
  const apiClient = useApiClient()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: { agentId: string; channelId: string; threadId: string }) =>
      apiClient.post<DemonstrationRecord>('/api/demonstrations', input),
    onSuccess: () => invalidateDemonstrations(queryClient),
  })
}

export const useStopDemonstration = () => {
  const apiClient = useApiClient()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (demonstrationId: string) =>
      apiClient.post<DemonstrationRecord>(`/api/demonstrations/${demonstrationId}/stop`, {}),
    onSuccess: () => invalidateDemonstrations(queryClient),
  })
}

export const useGeneralizeDemonstration = () => {
  const apiClient = useApiClient()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (demonstrationId: string) =>
      apiClient.post<DemonstrationRecord>(`/api/demonstrations/${demonstrationId}/generalize`, {}),
    onSuccess: () => {
      invalidateDemonstrations(queryClient)
      void queryClient.invalidateQueries({ queryKey: workflowKeys.templates })
    },
  })
}
