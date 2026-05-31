import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type {
  ProjectMemberRecord,
  ProjectRecord,
  TeamRecord,
} from '../../lib/api-client'
import { useApiClient } from '../../providers/ApiClientProvider'

export const useProjects = () => {
  const apiClient = useApiClient()

  return useQuery<ProjectRecord[]>({
    queryKey: ['projects'],
    queryFn: () => apiClient.get('/api/projects'),
    staleTime: Infinity,
  })
}

export const useProjectMembers = (projectId: string | null) => {
  const apiClient = useApiClient()

  return useQuery<ProjectMemberRecord[]>({
    enabled: Boolean(projectId),
    queryKey: ['project-members', projectId],
    queryFn: () => apiClient.get(`/api/projects/${projectId}/members`),
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

export const useDeleteProject = () => {
  const apiClient = useApiClient()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (projectId: string) =>
      apiClient.delete<{ ok: true }>(`/api/projects/${projectId}`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['projects'] })
      void queryClient.invalidateQueries({ queryKey: ['channels'] })
    },
  })
}

export const useAddProjectMember = () => {
  const apiClient = useApiClient()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (input: { projectId: string; userId: string; role?: string }) =>
      apiClient.post<{ ok: true }>(`/api/projects/${input.projectId}/members`, {
        userId: input.userId,
        role: input.role,
      }),
    onSuccess: (_data, variables) => {
      void queryClient.invalidateQueries({ queryKey: ['project-members', variables.projectId] })
      void queryClient.invalidateQueries({ queryKey: ['projects'] })
    },
  })
}

export const useRemoveProjectMember = () => {
  const apiClient = useApiClient()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (input: { projectId: string; userId: string }) =>
      apiClient.delete<{ ok: true }>(`/api/projects/${input.projectId}/members/${input.userId}`),
    onSuccess: (_data, variables) => {
      void queryClient.invalidateQueries({ queryKey: ['project-members', variables.projectId] })
      void queryClient.invalidateQueries({ queryKey: ['projects'] })
    },
  })
}
