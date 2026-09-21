import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  ExecutorAccessChangeRequestSchema,
  ExecutorAccessChangeResponseSchema,
  ExecutorAvailabilityResponseSchema,
  ExecutorRecordResponseSchema,
  ExecutorRunLaunchResponseSchema,
  ExecutorWorkspaceReviewRecordResponseSchema,
  ExecutorWorkspacePromotionRecordResponseSchema,
  OriginatingExecutorWorkspaceReviewRecordResponseSchema,
  PreparedExecutorWorkspacePromotionResponseSchema,
  PreparedExecutorAccessChangeResponseSchema,
  type ImplementedExecutorOperationKey,
} from '@nessie/schemas'

import type { ApiClient } from '../../lib/api-client'
import { threadKeys } from '../threads/keys'
import { executorKeys } from './keys'
import { ExecutorAccessViewWithLocalMcpSchema } from './local-mcp'
import { useApiClient } from '../../providers/ApiClientProvider'

export const useExecutors = () => {
  const apiClient = useApiClient()
  return useQuery({
    queryKey: executorKeys.all,
    queryFn: async () => ExecutorRecordResponseSchema.array().parse(
      await apiClient.get('/api/executors'),
    ),
  })
}

/**
 * The executor detail screen's first read, as a function so the row that
 * navigates there can prewarm it under the same key (navigation/prewarm.ts)
 * without spelling a second fetcher.
 */
export const fetchExecutorAccess = (apiClient: ApiClient, executorId: string) =>
  apiClient.get(`/api/executors/${executorId}/access`, ExecutorAccessViewWithLocalMcpSchema)

export const useExecutorAccess = (executorId?: string) => {
  const apiClient = useApiClient()
  return useQuery({
    // Consent must never show permissions retained from a different machine.
    placeholderData: undefined,
    queryKey: executorKeys.access(executorId),
    // Parsed by the client, not here. A hand-rolled `.parse()` throws a bare
    // ZodError, and this screen has to tell two failures apart: a server that
    // could not be reached, and a server whose payload this build cannot read.
    // Only the second names "your Nessie is older than the API", and only the
    // client's own parse path reports it — as an ApiClientError carrying
    // `INVALID_RESPONSE`. The distinction is not hypothetical: an embedded
    // desktop shell is frozen at its build, so one additive server field
    // hid this executor's whole access surface behind a screen that said
    // "unknown" instead of saying the app was stale.
    queryFn: async () => fetchExecutorAccess(apiClient, executorId as string),
    enabled: Boolean(executorId),
  })
}

export const useExecutorWorkspaceReviews = (executorId?: string) => {
  const apiClient = useApiClient()
  return useQuery({
    placeholderData: keepPreviousData,
    queryKey: executorKeys.workspaceReviews(executorId),
    queryFn: async () => ExecutorWorkspaceReviewRecordResponseSchema.array().parse(
      await apiClient.get(`/api/executors/${executorId}/workspace-reviews`),
    ),
    enabled: Boolean(executorId),
  })
}

export const useMyExecutorWorkspaceReviews = () => {
  const apiClient = useApiClient()
  return useQuery({
    queryKey: executorKeys.myWorkspaceReviews,
    queryFn: async () => OriginatingExecutorWorkspaceReviewRecordResponseSchema.array().parse(
      await apiClient.get('/api/executor-workspace-reviews/mine'),
    ),
  })
}

export const useExecutorWorkspacePromotion = (promotionId?: string) => {
  const apiClient = useApiClient()
  return useQuery({
    placeholderData: keepPreviousData,
    queryKey: executorKeys.workspacePromotion(promotionId),
    queryFn: async () => ExecutorWorkspacePromotionRecordResponseSchema.parse(
      await apiClient.get(`/api/executor-workspace-promotions/${promotionId}`),
    ),
    enabled: Boolean(promotionId),
    retry: false,
  })
}

export const useExecutorAccessChange = (accessChangeId?: string) => {
  const apiClient = useApiClient()
  return useQuery({
    // Each token approves one exact change; a previous change cannot stand in.
    placeholderData: undefined,
    queryKey: executorKeys.accessChange(accessChangeId),
    queryFn: async () => ExecutorAccessChangeResponseSchema.parse(
      await apiClient.get(`/api/executor-access-changes/${accessChangeId}`),
    ),
    enabled: Boolean(accessChangeId),
    retry: false,
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
      operationKeys: ImplementedExecutorOperationKey[]
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
      operationKeys: ImplementedExecutorOperationKey[]
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
      void queryClient.invalidateQueries({ queryKey: threadKeys.messages(input.threadId) })
    },
  })
}

export const usePrepareExecutorWorkspacePromotion = () => {
  const apiClient = useApiClient()
  return useMutation({
    mutationFn: async (input: { reviewCommandId: string }) =>
      PreparedExecutorWorkspacePromotionResponseSchema.parse(
        await apiClient.post('/api/executor-workspace-promotions', input),
      ),
  })
}

export const useConfirmExecutorWorkspacePromotion = () => {
  const apiClient = useApiClient()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: { confirmationToken: string; currentPassword: string; promotionId: string }) =>
      apiClient.post(`/api/executor-workspace-promotions/${input.promotionId}/confirm`, {
        confirmationToken: input.confirmationToken,
        currentPassword: input.currentPassword,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: executorKeys.all })
    },
  })
}

export const useRejectExecutorWorkspacePromotion = () => {
  const apiClient = useApiClient()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: { confirmationToken: string; promotionId: string }) =>
      apiClient.post(`/api/executor-workspace-promotions/${input.promotionId}/reject`, {
        confirmationToken: input.confirmationToken,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: executorKeys.all })
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
      void queryClient.invalidateQueries({ queryKey: executorKeys.detail(prepared.executorId) })
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
      void queryClient.invalidateQueries({ queryKey: executorKeys.all })
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
      void queryClient.invalidateQueries({ queryKey: executorKeys.all })
    },
  })
}
