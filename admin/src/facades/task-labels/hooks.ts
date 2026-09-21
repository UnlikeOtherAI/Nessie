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
 * many labels the board already has, so a run of quick creations from the
 * token field reads as distinct pills rather than twelve greys.
 */
export const nextLabelColor = (existingCount: number): LabelColor => {
  const size = LABEL_PALETTE.length
  const index = ((Math.trunc(existingCount) % size) + size) % size
  return LABEL_PALETTE[index] ?? LABEL_PALETTE[0]
}

/**
 * The label a `409 LABEL_NAME_TAKEN` names — the board's own label of that
 * name. The route returns it in the error envelope's `details` so a picker can
 * select it instead of failing; the shape is read defensively (`details` itself, or
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

/**
 * Every board's labels in a project, each with its `boardId` — the
 * project-wide read the backlog and search pages use. A label belongs to a
 * board (board-labels-and-attachment-removal.md §8); a ticket's field and the
 * board's settings read `useBoardLabels` instead.
 */
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

const boardLabelsPath = (projectId: string, boardId: string) =>
  `/api/projects/${projectId}/boards/${boardId}/labels`

/** One board's labels, ordered by name, with `taskCount`. */
export const useBoardLabels = (projectId?: string, boardId?: string | null) => {
  const apiClient = useApiClient()
  return useQuery<LabelListResponse, Error, TaskLabelRecord[]>({
    // Id-keyed, so it holds its previous answer while a refetch runs — but
    // only this board's: another board's labels are not this board's
    // vocabulary, and offering them would create links the server refuses.
    placeholderData: (previous, previousQuery) =>
      previousQuery?.queryKey[3] === boardId ? previous : undefined,
    queryKey: projectKeys.boardLabels(projectId ?? '', boardId ?? ''),
    queryFn: () => apiClient.get<LabelListResponse>(boardLabelsPath(projectId ?? '', boardId ?? '')),
    select: (data) => data.labels,
    enabled: Boolean(projectId && boardId),
  })
}

const invalidateLabels = (queryClient: ReturnType<typeof useQueryClient>, projectId: string) => {
  // The family root: the project-wide read and every board's list.
  void queryClient.invalidateQueries({ queryKey: projectKeys.labels(projectId) })
  // A rename, recolour or delete changes what every card carrying it paints.
  void queryClient.invalidateQueries({ queryKey: taskKeys.all })
}

export type CreateBoardLabelInput = CreateTaskLabelBody & {
  /**
   * Resolve with the board's existing label on `LABEL_NAME_TAKEN` instead of
   * failing — the token field's *Create label "x"* row, where the person meant
   * "this label" whether or not it already existed. Settings leaves it off and
   * shows the conflict on the field.
   */
  adoptExisting?: boolean
}

export const useCreateBoardLabel = (projectId: string, boardId: string) => {
  const apiClient = useApiClient()
  const queryClient = useQueryClient()
  return useMutation<TaskLabelRecord, Error, CreateBoardLabelInput>({
    mutationFn: async ({ adoptExisting, ...body }) => {
      try {
        return await apiClient.post<TaskLabelRecord>(boardLabelsPath(projectId, boardId), body)
      } catch (error) {
        const existing = adoptExisting ? takenLabelFromError(error) : null
        if (existing) return existing
        throw error
      }
    },
    onSuccess: () => invalidateLabels(queryClient, projectId),
  })
}

export const useUpdateBoardLabel = (projectId: string, boardId: string) => {
  const apiClient = useApiClient()
  const queryClient = useQueryClient()
  return useMutation<TaskLabelRecord, Error, UpdateTaskLabelBody & { id: string }>({
    mutationFn: ({ id, ...body }) =>
      apiClient.patch<TaskLabelRecord>(`${boardLabelsPath(projectId, boardId)}/${id}`, body),
    onSuccess: () => invalidateLabels(queryClient, projectId),
  })
}

export const useDeleteBoardLabel = (projectId: string, boardId: string) => {
  const apiClient = useApiClient()
  const queryClient = useQueryClient()
  return useMutation<null, Error, string>({
    mutationFn: (labelId) =>
      apiClient.delete<null>(`${boardLabelsPath(projectId, boardId)}/${labelId}`),
    onSuccess: () => invalidateLabels(queryClient, projectId),
  })
}
