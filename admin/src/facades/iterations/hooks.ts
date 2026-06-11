import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useApiClient } from '../../providers/ApiClientProvider'

export type IterationStatus = 'planned' | 'active' | 'completed'

export type Iteration = {
  id: string
  projectId: string
  name: string
  goal: string | null
  status: IterationStatus
  startDate: string | null
  endDate: string | null
  capacity: number | null
  position: number
  completedAt: string | null
  taskCount: number
  pointsTotal: number
  pointsDone: number
}

export type CreateIterationInput = {
  name: string
  goal?: string
  startDate?: string
  endDate?: string
  capacity?: number
}

export type UpdateIterationInput = {
  name?: string
  goal?: string | null
  startDate?: string | null
  endDate?: string | null
  capacity?: number | null
  action?: 'start' | 'complete'
}

const iterationsKey = (projectId: string) => ['iterations', projectId] as const

export const useIterations = (projectId?: string) => {
  const apiClient = useApiClient()
  return useQuery<Iteration[]>({
    queryKey: ['iterations', projectId ?? ''],
    queryFn: () => apiClient.get(`/api/projects/${projectId}/iterations`),
    enabled: Boolean(projectId),
  })
}

export const useCreateIteration = (projectId: string) => {
  const apiClient = useApiClient()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: CreateIterationInput) =>
      apiClient.post<Iteration>(`/api/projects/${projectId}/iterations`, input),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: iterationsKey(projectId) }),
  })
}

export const useUpdateIteration = (projectId: string) => {
  const apiClient = useApiClient()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: { id: string } & UpdateIterationInput) => {
      const { id, ...body } = input
      return apiClient.patch<Iteration>(`/api/iterations/${id}`, body)
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: iterationsKey(projectId) })
      void queryClient.invalidateQueries({ queryKey: ['tasks'] })
    },
  })
}

export const useDeleteIteration = (projectId: string) => {
  const apiClient = useApiClient()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (iterationId: string) =>
      apiClient.delete<{ ok: true }>(`/api/iterations/${iterationId}`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: iterationsKey(projectId) })
      void queryClient.invalidateQueries({ queryKey: ['tasks'] })
    },
  })
}
