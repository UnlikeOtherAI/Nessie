import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  ExecutorAccessChangeRequestSchema,
  ExecutorAccessChangeResponseSchema,
  ExecutorAccessViewResponseSchema,
  ExecutorAvailabilityResponseSchema,
  ExecutorCreateResponseSchema,
  ExecutorRecordResponseSchema,
  ExecutorRunLaunchResponseSchema,
  ExecutorWorkspaceReviewRecordResponseSchema,
  PendingExecutorEnrollmentResponseSchema,
  PreparedExecutorAccessChangeResponseSchema,
  type ExecutorOperationKey,
  type ExecutorPrivateAssignment,
  type ExecutorScope,
} from '@nessie/schemas'

import { useApiClient } from '../../providers/ApiClientProvider'

export const executorKeyPrefix = ['executors'] as const

const executorKey = (executorId: string) => [...executorKeyPrefix, executorId] as const

export const useExecutors = () => {
  const apiClient = useApiClient()
  return useQuery({
    queryKey: executorKeyPrefix,
    queryFn: async () => ExecutorRecordResponseSchema.array().parse(
      await apiClient.get('/api/executors'),
    ),
  })
}

export const useExecutorAccess = (executorId?: string) => {
  const apiClient = useApiClient()
  return useQuery({
    queryKey: executorId ? [...executorKey(executorId), 'access'] : [...executorKeyPrefix, 'none', 'access'],
    queryFn: async () => ExecutorAccessViewResponseSchema.parse(
      await apiClient.get(`/api/executors/${executorId}/access`),
    ),
    enabled: Boolean(executorId),
  })
}

export const useExecutorWorkspaceReviews = (executorId?: string) => {
  const apiClient = useApiClient()
  return useQuery({
    queryKey: executorId ? [...executorKey(executorId), 'workspace-reviews'] : [...executorKeyPrefix, 'none', 'workspace-reviews'],
    queryFn: async () => ExecutorWorkspaceReviewRecordResponseSchema.array().parse(
      await apiClient.get(`/api/executors/${executorId}/workspace-reviews`),
    ),
    enabled: Boolean(executorId),
  })
}

export const usePendingExecutorEnrollment = (executorId?: string) => {
  const apiClient = useApiClient()
  return useQuery({
    queryKey: executorId ? [...executorKey(executorId), 'pairing'] : [...executorKeyPrefix, 'none', 'pairing'],
    queryFn: async () => PendingExecutorEnrollmentResponseSchema.parse(
      await apiClient.get(`/api/executors/${executorId}/pairing-pending`),
    ),
    enabled: false,
    retry: false,
  })
}

export const useExecutorAccessChange = (accessChangeId?: string) => {
  const apiClient = useApiClient()
  return useQuery({
    queryKey: accessChangeId
      ? [...executorKeyPrefix, 'access-change', accessChangeId]
      : [...executorKeyPrefix, 'access-change', 'none'],
    queryFn: async () => ExecutorAccessChangeResponseSchema.parse(
      await apiClient.get(`/api/executor-access-changes/${accessChangeId}`),
    ),
    enabled: Boolean(accessChangeId),
    retry: false,
  })
}

export const useCreateExecutor = () => {
  const apiClient = useApiClient()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (input: {
      label: string
      privateAssignments?: ExecutorPrivateAssignment[]
      scope: ExecutorScope
    }) => ExecutorCreateResponseSchema.parse(await apiClient.post('/api/executors', input)),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: executorKeyPrefix })
    },
  })
}

/**
 * Availability returns opaque, short-lived choices. The UI intentionally never
 * receives executor identities or another private scope's membership roster.
 */
export const useExecutorAvailability = () => {
  const apiClient = useApiClient()
  return useMutation({
    mutationFn: async (input: {
      agentId: string
      operationKeys: ExecutorOperationKey[]
      projectId?: string
    }) => ExecutorAvailabilityResponseSchema.parse(
      await apiClient.post('/api/executor-availability', input),
    ),
  })
}

export const useLaunchExecutorRun = () => {
  const apiClient = useApiClient()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (input: {
      agentId: string
      candidateHandle: string
      content: string
      operationKeys: ExecutorOperationKey[]
      threadId: string
    }) => ExecutorRunLaunchResponseSchema.parse(
      await apiClient.post(`/api/threads/${input.threadId}/executor-runs`, {
        agentId: input.agentId,
        candidateHandle: input.candidateHandle,
        content: input.content,
        operationKeys: input.operationKeys,
      }),
    ),
    onSuccess: (_result, input) => {
      void queryClient.invalidateQueries({ queryKey: ['threads', input.threadId, 'messages'] })
    },
  })
}

export const useConfirmExecutorEnrollment = () => {
  const apiClient = useApiClient()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: { executorId: string; fingerprint: string }) =>
      apiClient.post(`/api/executors/${input.executorId}/pairing-confirm`, {
        fingerprint: input.fingerprint,
      }),
    onSuccess: (_result, input) => {
      void queryClient.invalidateQueries({ queryKey: executorKey(input.executorId) })
    },
  })
}

export const usePrepareExecutorAccessChange = () => {
  const apiClient = useApiClient()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (input: { change: unknown; executorId: string }) => {
      const change = ExecutorAccessChangeRequestSchema.parse(input.change)
      return PreparedExecutorAccessChangeResponseSchema.parse(
        await apiClient.post('/api/executor-access-changes', {
          executorId: input.executorId,
          change,
        }),
      )
    },
    onSuccess: (prepared) => {
      void queryClient.invalidateQueries({ queryKey: executorKey(prepared.executorId) })
    },
  })
}

export const useConfirmExecutorAccessChange = () => {
  const apiClient = useApiClient()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: {
      accessChangeId: string
      confirmationToken: string
      currentPassword?: string
    }) => apiClient.post(`/api/executor-access-changes/${input.accessChangeId}/confirm`, {
      confirmationToken: input.confirmationToken,
      ...(input.currentPassword ? { currentPassword: input.currentPassword } : {}),
    }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: executorKeyPrefix })
    },
  })
}

export const useRejectExecutorAccessChange = () => {
  const apiClient = useApiClient()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: { accessChangeId: string; confirmationToken: string }) =>
      apiClient.post(`/api/executor-access-changes/${input.accessChangeId}/reject`, {
        confirmationToken: input.confirmationToken,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: executorKeyPrefix })
    },
  })
}
