import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { iterationKeys, projectKeys, taskKeys } from '../../lib/query-keys'
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

export type ProjectInsights = {
  velocity: { iterationId: string; name: string; points: number }[]
  burndown: {
    iterationId: string
    name: string
    totalPoints: number
    days: { date: string; remaining: number; ideal: number }[]
  } | null
}

export const useProjectInsights = (projectId?: string) => {
  const apiClient = useApiClient()
  return useQuery<ProjectInsights>({
    queryKey: projectKeys.insights(projectId ?? ''),
    queryFn: () => apiClient.get(`/api/projects/${projectId}/insights`),
    enabled: Boolean(projectId),
  })
}

export const useIterations = (projectId?: string) => {
  const apiClient = useApiClient()
  return useQuery<Iteration[]>({
    queryKey: iterationKeys.forProject(projectId ?? ''),
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
    onSuccess: () => queryClient.invalidateQueries({ queryKey: iterationKeys.forProject(projectId) }),
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
      void queryClient.invalidateQueries({ queryKey: iterationKeys.forProject(projectId) })
      void queryClient.invalidateQueries({ queryKey: taskKeys.all })
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
      void queryClient.invalidateQueries({ queryKey: iterationKeys.forProject(projectId) })
      void queryClient.invalidateQueries({ queryKey: taskKeys.all })
    },
  })
}
