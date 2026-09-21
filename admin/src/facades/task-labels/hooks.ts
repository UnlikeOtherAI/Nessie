import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ApiClientError } from '@nessie/client-core'
import {
  LABEL_PALETTE,
  TaskLabelRecordSchema,
  type CreateTaskLabelBody,
  type LabelColor,
  type TaskLabelRecord,
  type UpdateTaskLabelBody,
} from '@nessie/schemas'
import { projectKeys } from '../projects/keys'
import { taskKeys } from '../tasks/keys'
import { useApiClient } from '../../providers/ApiClientProvider'

export type { TaskLabelRecord }

type LabelListResponse = { labels: TaskLabelRecord[] }

/**
 * The colour a label created without one gets: the palette in order, by how
 * many labels the project already has, so a run of quick creations from the
 * token field reads as distinct pills rather than twelve greys.
 */
export const nextLabelColor = (existingCount: number): LabelColor => {
  const size = LABEL_PALETTE.length
  const index = ((Math.trunc(existingCount) % size) + size) % size
  return LABEL_PALETTE[index] ?? LABEL_PALETTE[0]
}

/**
 * The label a `409 LABEL_NAME_TAKEN` names. The route returns the existing
 * label in the error envelope's `details` so a picker can select it instead of
 * failing; the shape is read defensively (`details` itself, or
 * `details.label`) and parsed, never trusted.
 */
export const takenLabelFromError = (error: unknown): TaskLabelRecord | null => {
  if (!(error instanceof ApiClientError) || error.code !== 'LABEL_NAME_TAKEN') return null
  const details = error.details as { label?: unknown } | null | undefined
  for (const candidate of [details?.label, details]) {
    const parsed = TaskLabelRecordSchema.safeParse(candidate)
    if (parsed.success) return parsed.data
  }
  return null
}

/** A project's labels, ordered by name, with `taskCount`. */
export const useProjectLabels = (projectId?: string) => {
  const apiClient = useApiClient()
  return useQuery<LabelListResponse, Error, TaskLabelRecord[]>({
    // Label names and colours are project metadata every member already sees
    // on the project's cards; replaying them across a project switch is the
    // `useTaskFields` trade.
    placeholderData: keepPreviousData,
    queryKey: projectKeys.labels(projectId ?? ''),
    queryFn: () => apiClient.get<LabelListResponse>(`/api/projects/${projectId}/labels`),
    select: (data) => data.labels,
    enabled: Boolean(projectId),
  })
}

const invalidateLabels = (queryClient: ReturnType<typeof useQueryClient>, projectId: string) => {
  void queryClient.invalidateQueries({ queryKey: projectKeys.labels(projectId) })
  // A rename, recolour or delete changes what every card carrying it paints.
  void queryClient.invalidateQueries({ queryKey: taskKeys.all })
}

export type CreateProjectLabelInput = CreateTaskLabelBody & {
  /**
   * Resolve with the existing label on `LABEL_NAME_TAKEN` instead of failing —
   * the token field's *Create label "x"* row, where the person meant "this
   * label" whether or not it already existed. Settings leaves it off and shows
   * the conflict on the field.
   */
  adoptExisting?: boolean
}

export const useCreateProjectLabel = (projectId: string) => {
  const apiClient = useApiClient()
  const queryClient = useQueryClient()
  return useMutation<TaskLabelRecord, Error, CreateProjectLabelInput>({
    mutationFn: async ({ adoptExisting, ...body }) => {
      try {
        return await apiClient.post<TaskLabelRecord>(`/api/projects/${projectId}/labels`, body)
      } catch (error) {
        const existing = adoptExisting ? takenLabelFromError(error) : null
        if (existing) return existing
        throw error
      }
    },
    onSuccess: () => invalidateLabels(queryClient, projectId),
  })
}

export const useUpdateProjectLabel = (projectId: string) => {
  const apiClient = useApiClient()
  const queryClient = useQueryClient()
  return useMutation<TaskLabelRecord, Error, UpdateTaskLabelBody & { id: string }>({
    mutationFn: ({ id, ...body }) =>
      apiClient.patch<TaskLabelRecord>(`/api/projects/${projectId}/labels/${id}`, body),
    onSuccess: () => invalidateLabels(queryClient, projectId),
  })
}

export const useDeleteProjectLabel = (projectId: string) => {
  const apiClient = useApiClient()
  const queryClient = useQueryClient()
  return useMutation<null, Error, string>({
    mutationFn: (labelId) =>
      apiClient.delete<null>(`/api/projects/${projectId}/labels/${labelId}`),
    onSuccess: () => invalidateLabels(queryClient, projectId),
  })
}
