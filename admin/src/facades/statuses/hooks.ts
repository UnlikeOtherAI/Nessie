import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type {
  UserStatusRecord,
  UserStatusRuleScope,
  UserStatusScheduleKind,
} from '../../lib/api-client'
import { presenceKeys } from '../presence/keys'
import { userKeys } from '../users/keys'
import { statusKeys } from './keys'
import { useApiClient } from '../../providers/ApiClientProvider'

const useStatusInvalidation = () => {
  const queryClient = useQueryClient()
  return () => {
    void queryClient.invalidateQueries({ queryKey: statusKeys.all })
    void queryClient.invalidateQueries({ queryKey: userKeys.all })
    // Presence carries each user's active-status emoji, so refresh it too.
    void queryClient.invalidateQueries({ queryKey: presenceKeys.all })
  }
}

export const useStatuses = () => {
  const apiClient = useApiClient()

  return useQuery<UserStatusRecord[]>({
    queryKey: statusKeys.all,
    queryFn: () => apiClient.get('/api/statuses'),
  })
}

export const useCreateStatus = () => {
  const apiClient = useApiClient()
  const invalidate = useStatusInvalidation()

  return useMutation({
    mutationFn: (input: {
      agentEnabled?: boolean
      agentInstructions?: string | null
      emoji?: string | null
      label: string
    }) => apiClient.post<UserStatusRecord>('/api/statuses', input),
    onSuccess: invalidate,
  })
}

export const useUpdateStatus = () => {
  const apiClient = useApiClient()
  const invalidate = useStatusInvalidation()

  return useMutation({
    mutationFn: (input: {
      agentEnabled?: boolean
      agentInstructions?: string | null
      emoji?: string | null
      label?: string
      statusId: string
    }) => {
      const { statusId, ...body } = input
      return apiClient.patch<UserStatusRecord>(`/api/statuses/${statusId}`, body)
    },
    onSuccess: invalidate,
  })
}

export const useDeleteStatus = () => {
  const apiClient = useApiClient()
  const invalidate = useStatusInvalidation()

  return useMutation({
    mutationFn: (statusId: string) => apiClient.delete<{ ok: true }>(`/api/statuses/${statusId}`),
    onSuccess: invalidate,
  })
}

export const useActivateStatus = () => {
  const apiClient = useApiClient()
  const invalidate = useStatusInvalidation()

  return useMutation({
    mutationFn: (statusId: string) =>
      apiClient.post<UserStatusRecord>(`/api/statuses/${statusId}/activate`),
    onSuccess: invalidate,
  })
}

export const useClearActiveStatus = () => {
  const apiClient = useApiClient()
  const invalidate = useStatusInvalidation()

  return useMutation({
    mutationFn: () => apiClient.delete<{ ok: true }>('/api/statuses/active'),
    onSuccess: invalidate,
  })
}

export const useCreateStatusSchedule = () => {
  const apiClient = useApiClient()
  const invalidate = useStatusInvalidation()

  return useMutation({
    mutationFn: (input: {
      dayOfWeek?: number | null
      enabled?: boolean
      endTime?: string | null
      endsAt?: string | null
      kind: UserStatusScheduleKind
      label?: string | null
      startTime?: string | null
      startsAt?: string | null
      statusId: string
      timezone?: string
    }) => {
      const { statusId, ...body } = input
      return apiClient.post<UserStatusRecord>(`/api/statuses/${statusId}/schedules`, body)
    },
    onSuccess: invalidate,
  })
}

export const useDeleteStatusSchedule = () => {
  const apiClient = useApiClient()
  const invalidate = useStatusInvalidation()

  return useMutation({
    mutationFn: (input: { scheduleId: string; statusId: string }) =>
      apiClient.delete<UserStatusRecord>(
        `/api/statuses/${input.statusId}/schedules/${input.scheduleId}`,
      ),
    onSuccess: invalidate,
  })
}

export const useCreateStatusRule = () => {
  const apiClient = useApiClient()
  const invalidate = useStatusInvalidation()

  return useMutation({
    mutationFn: (input: {
      agentEnabled?: boolean
      agentId?: string | null
      channelId?: string | null
      instructions: string
      priority?: number
      projectId?: string | null
      scope: UserStatusRuleScope
      statusId: string
    }) => {
      const { statusId, ...body } = input
      return apiClient.post<UserStatusRecord>(`/api/statuses/${statusId}/rules`, body)
    },
    onSuccess: invalidate,
  })
}

export const useDeleteStatusRule = () => {
  const apiClient = useApiClient()
  const invalidate = useStatusInvalidation()

  return useMutation({
    mutationFn: (input: { ruleId: string; statusId: string }) =>
      apiClient.delete<UserStatusRecord>(
        `/api/statuses/${input.statusId}/rules/${input.ruleId}`,
      ),
    onSuccess: invalidate,
  })
}
