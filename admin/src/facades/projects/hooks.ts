import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ProjectRecordSchema } from '@nessie/schemas'
import type {
  ProjectMemberRecord,
  ProjectRecord,
  TeamRecord,
} from '../../lib/api-client'
import { channelKeys } from '../channels/keys'
import { teamKeys } from '../team/keys'
import { projectKeys } from './keys'
import { useApiClient } from '../../providers/ApiClientProvider'

export const useProjects = (enabled = true) => {
  const apiClient = useApiClient()

  return useQuery<ProjectRecord[]>({
    queryKey: projectKeys.all,
    queryFn: () => apiClient.get('/api/projects', ProjectRecordSchema.array()),
    enabled,
    staleTime: Infinity,
  })
}

export const useProjectMembers = (projectId: string | null) => {
  const apiClient = useApiClient()

  return useQuery<ProjectMemberRecord[]>({
    enabled: Boolean(projectId),
    queryKey: projectKeys.members(projectId),
    queryFn: () => apiClient.get(`/api/projects/${projectId}/members`),
    // Membership is an entitlement, not display data. Do not carry a previous
    // project's role into a new route, and re-check a mounted surface when it
    // regains focus so a role change takes effect without a page reload.
    refetchOnMount: 'always',
    refetchOnWindowFocus: 'always',
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

export const useRenameTeam = () => {
  const apiClient = useApiClient()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: ({ teamId, name }: { teamId: string; name: string }) =>
      apiClient.patch<{ id: string; name: string }>(`/api/teams/${teamId}`, { name }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: teamKeys.all })
    },
  })
}

export const useCreateProject = () => {
  const apiClient = useApiClient()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (input: { name: string; teamId: string }) =>
      apiClient.post<ProjectRecord>('/api/projects', input, undefined, ProjectRecordSchema),
    onSuccess: async () => {
      // The sidebar resolves a project's explicit channel target from the
      // team's canonical `projectIds`. Refresh both directories together so a
      // second project created under one team never posts a channel without
      // the team id the route requires.
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: projectKeys.all }),
        queryClient.invalidateQueries({ queryKey: teamKeys.all }),
      ])
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

/** Updates the call-link provider a team uses when a person presses Call. */
export const useUpdateTeamCallProvider = () => {
  const apiClient = useApiClient()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (input: { callProvider: TeamRecord['callProvider']; teamId: string }) =>
      apiClient.patch<Pick<TeamRecord, 'callProvider' | 'id'>>(
        `/api/teams/${input.teamId}/settings`,
        { callProvider: input.callProvider },
      ),
    onSuccess: (updated) => {
      queryClient.setQueryData<TeamRecord[]>(teamKeys.all, (teams) =>
        teams?.map((team) =>
          team.id === updated.id ? { ...team, callProvider: updated.callProvider } : team,
        ),
      )
      void queryClient.invalidateQueries({ queryKey: teamKeys.all })
    },
  })
}

export const useUpdateProject = () => {
  const apiClient = useApiClient()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (input: {
      avatarAttachmentId: string | null
      avatarEmoji: string | null
      name: string
      projectId: string
    }) =>
      apiClient.patch<ProjectRecord>(
        `/api/projects/${input.projectId}`,
        {
          avatarAttachmentId: input.avatarAttachmentId,
          avatarEmoji: input.avatarEmoji,
          name: input.name,
        },
        undefined,
        ProjectRecordSchema,
      ),
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
    onSuccess: (_data, input) => {
      void queryClient.invalidateQueries({ queryKey: projectKeys.all })
      void queryClient.invalidateQueries({ queryKey: projectKeys.members(input.projectId) })
    },
  })
}

export const useRemoveProjectMember = () => {
  const apiClient = useApiClient()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (input: { projectId: string; userId: string }) =>
      apiClient.delete<{ ok: true }>(`/api/projects/${input.projectId}/members/${input.userId}`),
    onSuccess: (_data, input) => {
      void queryClient.invalidateQueries({ queryKey: projectKeys.all })
      void queryClient.invalidateQueries({ queryKey: projectKeys.members(input.projectId) })
    },
  })
}
