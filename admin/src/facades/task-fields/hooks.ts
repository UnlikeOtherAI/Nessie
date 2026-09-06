import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type {
  TaskFieldConfig,
  TaskFieldDefinitionRecord,
  TaskFieldOption,
  TaskFieldType,
} from '@nessie/schemas'
import { projectKeys, taskKeys } from '../../lib/query-keys'
import { useApiClient } from '../../providers/ApiClientProvider'

export type { TaskFieldConfig, TaskFieldDefinitionRecord, TaskFieldOption, TaskFieldType }

/** A project's custom task fields. Read by the board, the dialog and settings. */
export const useTaskFields = (projectId?: string) => {
  const apiClient = useApiClient()
  return useQuery<TaskFieldDefinitionRecord[]>({
    placeholderData: keepPreviousData,
    queryKey: projectKeys.fields(projectId ?? ''),
    queryFn: () => apiClient.get(`/api/projects/${projectId}/fields`),
    enabled: Boolean(projectId),
  })
}

const invalidateFields = (
  queryClient: ReturnType<typeof useQueryClient>,
  projectId: string,
) => {
  void queryClient.invalidateQueries({ queryKey: projectKeys.fields(projectId) })
  // A definition change alters what every card renders, so the board refetches.
  void queryClient.invalidateQueries({ queryKey: taskKeys.all })
}

export const useCreateTaskField = (projectId: string) => {
  const apiClient = useApiClient()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: {
      name: string
      type: TaskFieldType
      options?: TaskFieldOption[]
      config?: TaskFieldConfig
      showOnCard?: boolean
    }) =>
      apiClient.post<TaskFieldDefinitionRecord>(`/api/projects/${projectId}/fields`, input),
    onSuccess: () => invalidateFields(queryClient, projectId),
  })
}

export const useUpdateTaskField = (projectId: string) => {
  const apiClient = useApiClient()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: {
      id: string
      name?: string
      options?: TaskFieldOption[]
      config?: TaskFieldConfig
      showOnCard?: boolean
      position?: number
    }) => {
      const { id, ...body } = input
      return apiClient.patch<TaskFieldDefinitionRecord>(
        `/api/projects/${projectId}/fields/${id}`,
        body,
      )
    },
    onSuccess: () => invalidateFields(queryClient, projectId),
  })
}

export const useDeleteTaskField = (projectId: string) => {
  const apiClient = useApiClient()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (fieldId: string) =>
      apiClient.delete<{ ok: true }>(`/api/projects/${projectId}/fields/${fieldId}`),
    onSuccess: () => invalidateFields(queryClient, projectId),
  })
}
