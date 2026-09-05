import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type {
  BoardSourceConnectionRecord,
  BoardSourceDetailRecord,
  BoardSourceFieldMapping,
  BoardSourceProvider,
  BoardSourceRecord,
  BoardSourceStateMapping,
  BoardSourceWriteMode,
} from '@nessie/schemas'
import { boardSourceKeys, projectKeys, taskKeys } from '../../lib/query-keys'
import { useApiClient } from '../../providers/ApiClientProvider'

export type {
  BoardSourceConnectionRecord,
  BoardSourceDetailRecord,
  BoardSourceFieldMapping,
  BoardSourceProvider,
  BoardSourceRecord,
  BoardSourceStateMapping,
  BoardSourceWriteMode,
}

export type ContainerDescriptor = {
  key: string
  container: Record<string, unknown>
  label: string
  hint?: string
}

export const PROVIDER_LABEL: Record<BoardSourceProvider, string> = {
  jira: 'Jira',
  linear: 'Linear',
  trello: 'Trello',
  github: 'GitHub',
}

/** The providers this deployment actually has credentials for. */
export const useBoardSourceProviders = () => {
  const apiClient = useApiClient()
  return useQuery<{ provider: BoardSourceProvider }[]>({
    queryKey: boardSourceKeys.providers,
    queryFn: () => apiClient.get('/api/board-sources/providers'),
    staleTime: 5 * 60 * 1000,
  })
}

export const useBoardSourceConnections = () => {
  const apiClient = useApiClient()
  return useQuery<BoardSourceConnectionRecord[]>({
    queryKey: boardSourceKeys.connections,
    queryFn: () => apiClient.get('/api/board-sources/connections'),
  })
}

export const useConnectionContainers = (connectionId?: string) => {
  const apiClient = useApiClient()
  return useQuery<ContainerDescriptor[]>({
    queryKey: boardSourceKeys.containers(connectionId),
    queryFn: () =>
      apiClient.get(`/api/board-sources/connections/${connectionId}/containers`),
    enabled: Boolean(connectionId),
  })
}

export const useStartConnection = () => {
  const apiClient = useApiClient()
  return useMutation({
    mutationFn: (input: { provider: BoardSourceProvider; reauthorizeConnectionId?: string }) =>
      apiClient.post<{ authorizeUrl: string }>(
        `/api/board-sources/connections/${input.provider}/start`,
        { reauthorizeConnectionId: input.reauthorizeConnectionId },
      ),
  })
}

export const useDeleteConnection = () => {
  const apiClient = useApiClient()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (connectionId: string) =>
      apiClient.delete<{ ok: true }>(`/api/board-sources/connections/${connectionId}`),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: boardSourceKeys.connections }),
  })
}

export const useProjectSources = (projectId?: string) => {
  const apiClient = useApiClient()
  return useQuery<BoardSourceRecord[]>({
    placeholderData: keepPreviousData,
    queryKey: projectKeys.sources(projectId ?? ''),
    queryFn: () => apiClient.get(`/api/projects/${projectId}/sources`),
    enabled: Boolean(projectId),
  })
}

export const useProjectSource = (projectId?: string, sourceId?: string) => {
  const apiClient = useApiClient()
  return useQuery<BoardSourceDetailRecord>({
    queryKey: projectKeys.source(projectId ?? '', sourceId),
    queryFn: () => apiClient.get(`/api/projects/${projectId}/sources/${sourceId}`),
    enabled: Boolean(projectId && sourceId),
  })
}

const invalidateSources = (
  queryClient: ReturnType<typeof useQueryClient>,
  projectId: string,
) => {
  void queryClient.invalidateQueries({ queryKey: projectKeys.sources(projectId) })
  void queryClient.invalidateQueries({ queryKey: taskKeys.all })
}

export const useCreateProjectSource = (projectId: string) => {
  const apiClient = useApiClient()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: {
      connectionId: string
      container: Record<string, unknown>
      name?: string
    }) => apiClient.post<BoardSourceRecord>(`/api/projects/${projectId}/sources`, input),
    onSuccess: () => invalidateSources(queryClient, projectId),
  })
}

export const useUpdateProjectSource = (projectId: string) => {
  const apiClient = useApiClient()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: {
      id: string
      name?: string
      writeMode?: BoardSourceWriteMode
      syncWindowDays?: number
      connectionId?: string
    }) => {
      const { id, ...body } = input
      return apiClient.patch<BoardSourceRecord>(
        `/api/projects/${projectId}/sources/${id}`,
        body,
      )
    },
    onSuccess: () => invalidateSources(queryClient, projectId),
  })
}

export const usePutSourceMappings = (projectId: string) => {
  const apiClient = useApiClient()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: {
      id: string
      stateMapping: BoardSourceStateMapping[]
      fieldMappings: BoardSourceFieldMapping[]
      identityLinks: {
        externalUserId: string
        externalDisplayName?: string | null
        userId?: string | null
        agentId?: string | null
      }[]
    }) => {
      const { id, ...body } = input
      return apiClient.put<BoardSourceRecord>(
        `/api/projects/${projectId}/sources/${id}/mappings`,
        body,
      )
    },
    onSuccess: () => invalidateSources(queryClient, projectId),
  })
}

/** The explicit health actions: sync now, pause, resume, retry. */
export const useSourceAction = (projectId: string) => {
  const apiClient = useApiClient()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: { id: string; action: 'sync' | 'pause' | 'resume' | 'retry' }) =>
      apiClient.post<{ ok: true }>(
        `/api/projects/${projectId}/sources/${input.id}/${input.action}`,
        {},
      ),
    onSuccess: () => invalidateSources(queryClient, projectId),
  })
}

export const useDeleteProjectSource = (projectId: string) => {
  const apiClient = useApiClient()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (sourceId: string) =>
      apiClient.delete<{ ok: true }>(`/api/projects/${projectId}/sources/${sourceId}`),
    onSuccess: () => invalidateSources(queryClient, projectId),
  })
}
