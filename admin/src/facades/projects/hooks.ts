import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type {
  ProjectMemberRecord,
  ProjectRecord,
  TeamRecord,
} from '../../lib/api-client'
import { channelKeys, projectKeys, teamKeys } from '../../lib/query-keys'
import { useApiClient } from '../../providers/ApiClientProvider'

export const useProjects = () => {
  const apiClient = useApiClient()

  return useQuery<ProjectRecord[]>({
    queryKey: projectKeys.all,
    queryFn: () => apiClient.get('/api/projects'),
    staleTime: Infinity,
  })
}

export const useProjectMembers = (projectId: string | null) => {
  const apiClient = useApiClient()

  return useQuery<ProjectMemberRecord[]>({
    enabled: Boolean(projectId),
    queryKey: projectKeys.members(projectId),
    queryFn: () => apiClient.get(`/api/projects/${projectId}/members`),
  })
}

export const useTeams = () => {
  const apiClient = useApiClient()

  return useQuery<TeamRecord[]>({
    queryKey: teamKeys.all,
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
      void queryClient.invalidateQueries({ queryKey: projectKeys.all })
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
      void queryClient.invalidateQueries({ queryKey: teamKeys.all })
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
      void queryClient.invalidateQueries({ queryKey: projectKeys.all })
      void queryClient.invalidateQueries({ queryKey: channelKeys.all })
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
      void queryClient.invalidateQueries({ queryKey: projectKeys.all })
      void queryClient.invalidateQueries({ queryKey: channelKeys.all })
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
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: projectKeys.all })
    },
  })
}

export const useRemoveProjectMember = () => {
  const apiClient = useApiClient()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (input: { projectId: string; userId: string }) =>
      apiClient.delete<{ ok: true }>(`/api/projects/${input.projectId}/members/${input.userId}`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: projectKeys.all })
    },
  })
}
