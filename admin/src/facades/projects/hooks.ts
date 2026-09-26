import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ProjectDirectoryEntrySchema, ProjectRecordSchema, type ProjectDirectoryEntry } from '@nessie/schemas'
import type {
  ProjectMemberRecord,
  ProjectRecord,
  TeamRecord,
} from '../../lib/api-client'
import { channelKeys } from '../channels/keys'
import { teamKeys } from '../team/keys'
import { projectKeys } from './keys'
import { useApiClient } from '../../providers/ApiClientProvider'

/**
 * How every team-directory mutation refreshes the team list. `exact` is
 * load-bearing: the avatar-revision counter nests under `teamKeys.all` (the
 * key-family invariant requires it), and a prefix invalidation refetches that
 * always-active query — whose constant queryFn resets the cache-buster to 0,
 * repainting the pre-upload avatar. The team list's own key IS `teamKeys.all`,
 * so `exact: true` still refetches the list itself.
 */
export const TEAM_DIRECTORY_INVALIDATION = { queryKey: teamKeys.all, exact: true } as const

export const useProjects = (enabled = true) => {
  const apiClient = useApiClient()

  return useQuery<ProjectRecord[]>({
    queryKey: projectKeys.all,
    queryFn: () => apiClient.get('/api/projects', ProjectRecordSchema.array()),
    enabled,
    staleTime: 60_000,
    refetchOnWindowFocus: true,
  })
}

/**
 * Every project in the organisation, shaped by role: a project the viewer is
 * not in carries only its name, description and members.
 */
export const useProjectDirectory = () => {
  const apiClient = useApiClient()

  return useQuery<ProjectDirectoryEntry[]>({
    queryKey: projectKeys.directory,
    queryFn: () => apiClient.get('/api/projects/directory', ProjectDirectoryEntrySchema.array()),
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
    staleTime: 60_000,
    refetchOnWindowFocus: true,
  })
}

export const useRenameTeam = () => {
  const apiClient = useApiClient()
  const queryClient = useQueryClient()

  return useMutation({
    // `slug` is the team's address label. It is sent on the same request as the
    // name because UnlikeOtherAI stores them together and validates the label
    // there; omitting it leaves the current address alone.
    mutationFn: ({ name, slug, teamId }: { name: string; slug?: string; teamId: string }) =>
      apiClient.patch<{ id: string; name: string; slug?: string }>(
        `/api/teams/${teamId}`,
        { name, ...(slug === undefined ? {} : { slug }) },
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries(TEAM_DIRECTORY_INVALIDATION)
    },
  })
}

export const useCreateProject = () => {
  const apiClient = useApiClient()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (input: { name: string; teamId: string; visibility?: 'protected' | 'public' }) =>
      apiClient.post<ProjectRecord>('/api/projects', input, undefined, ProjectRecordSchema),
    onSuccess: async () => {
      // The sidebar resolves a project's explicit channel target from the
      // team's canonical `projectIds`. Refresh both directories together so a
      // second project created under one team never posts a channel without
      // the team id the route requires.
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: projectKeys.all }),
        queryClient.invalidateQueries(TEAM_DIRECTORY_INVALIDATION),
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
      void queryClient.invalidateQueries(TEAM_DIRECTORY_INVALIDATION)
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
      void queryClient.invalidateQueries(TEAM_DIRECTORY_INVALIDATION)
    },
  })
}

export const useUpdateProject = () => {
  const apiClient = useApiClient()
  const queryClient = useQueryClient()

  return useMutation({
    // Only the fields a caller names are sent: `PATCH /api/projects/:id`
    // treats an absent field as unchanged, and Settings › General saves what
    // the person actually edited rather than restating the rest.
    mutationFn: ({ projectId, ...fields }: {
      avatarAttachmentId?: string | null
      avatarEmoji?: string | null
      description?: string | null
      name?: string
      projectId: string
      visibility?: 'public' | 'protected'
    }) =>
      apiClient.patch<ProjectRecord>(
        `/api/projects/${projectId}`,
        Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined)),
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
