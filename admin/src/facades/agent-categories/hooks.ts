import {
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query'
import type { AgentCategoryRecord } from '../../lib/api-client'
import { useApiClient } from '../../providers/ApiClientProvider'

export const useAgentCategories = () => {
  const apiClient = useApiClient()

  return useQuery<AgentCategoryRecord[]>({
    queryKey: ['agent-categories'],
    queryFn: () => apiClient.get('/api/agent-categories'),
  })
}

export const useCreateAgentCategory = () => {
  const apiClient = useApiClient()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (input: {
      name: string
      visibility?: 'private' | 'public'
    }) =>
      apiClient.post<AgentCategoryRecord>('/api/agent-categories', input),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: ['agent-categories'],
      })
    },
  })
}

export const useUpdateAgentCategory = () => {
  const apiClient = useApiClient()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (input: {
      categoryId: string
      name?: string
      visibility?: 'private' | 'public'
    }) => {
      const { categoryId, ...body } = input
      return apiClient.put<AgentCategoryRecord>(
        `/api/agent-categories/${categoryId}`,
        body,
      )
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: ['agent-categories'],
      })
    },
  })
}

export const useDeleteAgentCategory = () => {
  const apiClient = useApiClient()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (categoryId: string) =>
      apiClient.delete(`/api/agent-categories/${categoryId}`),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: ['agent-categories'],
      })
    },
  })
}

export const useAddAgentToCategory = () => {
  const apiClient = useApiClient()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (input: { agentId: string; categoryId: string }) =>
      apiClient.post<AgentCategoryRecord>(
        `/api/agent-categories/${input.categoryId}/agents`,
        { agentId: input.agentId },
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: ['agent-categories'],
      })
    },
  })
}

export const useRemoveAgentFromCategory = () => {
  const apiClient = useApiClient()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (input: { agentId: string; categoryId: string }) =>
      apiClient.delete(
        `/api/agent-categories/${input.categoryId}/agents/${input.agentId}`,
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: ['agent-categories'],
      })
    },
  })
}
