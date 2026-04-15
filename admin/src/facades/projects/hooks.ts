import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { ProjectRecord, TeamRecord } from '../../lib/api-client'
import { useApiClient } from '../../providers/ApiClientProvider'

export const useProjects = () => {
  const apiClient = useApiClient()

  return useQuery<ProjectRecord[]>({
    queryKey: ['projects'],
    queryFn: () => apiClient.get('/api/projects'),
    staleTime: Infinity,
  })
}

export const useTeams = () => {
  const apiClient = useApiClient()

  return useQuery<TeamRecord[]>({
    queryKey: ['teams'],
    queryFn: () => apiClient.get('/api/teams'),
    staleTime: Infinity,
  })
}

export const useCreateProject = () => {
  const apiClient = useApiClient()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (input: { name: string }) =>
      apiClient.post<ProjectRecord>('/api/projects', input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['projects'] })
    },
  })
}

export const useCreateTeam = () => {
  const apiClient = useApiClient()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (input: { name: string; projectId: string }) =>
      apiClient.post<TeamRecord>('/api/teams', input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['teams'] })
    },
  })
}

export const useRenameProject = () => {
  const apiClient = useApiClient()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (input: { name: string; projectId: string }) =>
      apiClient.patch<ProjectRecord>(`/api/projects/${input.projectId}`, {
        name: input.name,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['projects'] })
      void queryClient.invalidateQueries({ queryKey: ['channels'] })
    },
  })
}
