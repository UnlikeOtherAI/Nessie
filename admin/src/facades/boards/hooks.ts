import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type {
  BoardColumnRecord,
  BoardFilter,
  BoardRecord,
  BoardStyle,
  ColumnCategory,
} from '@nessie/schemas'
import type { ApiClient } from '../../lib/api-client'
import { projectKeys, taskKeys } from '../../lib/query-keys'
import { useApiClient } from '../../providers/ApiClientProvider'
import type { TaskRecord } from '../tasks/hooks'

/**
 * A project's boards. One read (`GET /api/projects/:id/boards`) serves the
 * board tab, project settings, the Overview work section and the navigation
 * prewarm — boards are small and always wanted together, and a per-board read
 * would make the switcher wait on a second round trip to draw its own tabs.
 */

export type { BoardColumnRecord, BoardFilter, BoardRecord, BoardStyle, ColumnCategory }

/** A task as one board renders it — the server has already placed it. */
export type BoardTaskRecord = TaskRecord & {
  columnId: string | null
  position: number | null
}

export type BoardTasksResponse = {
  tasks: BoardTaskRecord[]
  /** True when the board is showing only the most recently updated cards. */
  truncated: boolean
}

/** Shared with `navigation/prewarm.ts`; see `fetchThreadMessages` for why. */
export const fetchProjectBoards = (
  apiClient: ApiClient,
  projectId: string,
): Promise<BoardRecord[]> => apiClient.get(`/api/projects/${projectId}/boards`)

export const useProjectBoards = (projectId?: string) => {
  const apiClient = useApiClient()
  return useQuery<BoardRecord[]>({
    placeholderData: keepPreviousData,
    queryKey: projectKeys.boards(projectId ?? ''),
    queryFn: () => fetchProjectBoards(apiClient, projectId ?? ''),
    enabled: Boolean(projectId),
  })
}

export const useBoardTasks = (projectId?: string, boardId?: string) => {
  const apiClient = useApiClient()
  return useQuery<BoardTasksResponse>({
    placeholderData: keepPreviousData,
    queryKey: taskKeys.forBoard(projectId, boardId),
    queryFn: () =>
      apiClient.get(`/api/projects/${projectId}/boards/${boardId}/tasks`),
    enabled: Boolean(projectId && boardId),
  })
}

const invalidateBoards = (
  queryClient: ReturnType<typeof useQueryClient>,
  projectId: string,
) => {
  void queryClient.invalidateQueries({ queryKey: projectKeys.boards(projectId) })
  void queryClient.invalidateQueries({ queryKey: taskKeys.all })
}

export const useCreateBoard = (projectId: string) => {
  const apiClient = useApiClient()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: {
      name: string
      style?: BoardStyle
      copyColumnsFromBoardId?: string
    }) => apiClient.post<BoardRecord>(`/api/projects/${projectId}/boards`, input),
    onSuccess: () => invalidateBoards(queryClient, projectId),
  })
}

export const useUpdateBoard = (projectId: string) => {
  const apiClient = useApiClient()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: {
      id: string
      name?: string
      style?: BoardStyle
      filter?: BoardFilter
      position?: number
      isDefault?: true
    }) => {
      const { id, ...body } = input
      return apiClient.patch<BoardRecord>(
        `/api/projects/${projectId}/boards/${id}`,
        body,
      )
    },
    onSuccess: () => invalidateBoards(queryClient, projectId),
  })
}

export const useDeleteBoard = (projectId: string) => {
  const apiClient = useApiClient()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: { id: string; newDefaultBoardId?: string }) =>
      apiClient.delete<{ ok: true }>(
        `/api/projects/${projectId}/boards/${input.id}${
          input.newDefaultBoardId
            ? `?newDefaultBoardId=${input.newDefaultBoardId}`
            : ''
        }`,
      ),
    onSuccess: () => invalidateBoards(queryClient, projectId),
  })
}

export const useCreateColumn = (projectId: string, boardId: string) => {
  const apiClient = useApiClient()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: { name: string; category: ColumnCategory }) =>
      apiClient.post<BoardColumnRecord>(
        `/api/projects/${projectId}/boards/${boardId}/columns`,
        input,
      ),
    onSuccess: () => invalidateBoards(queryClient, projectId),
  })
}

export const useUpdateColumn = (projectId: string, boardId: string) => {
  const apiClient = useApiClient()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: {
      id: string
      name?: string
      category?: ColumnCategory
      position?: number
    }) =>
      apiClient.patch<BoardColumnRecord>(
        `/api/projects/${projectId}/boards/${boardId}/columns/${input.id}`,
        { name: input.name, category: input.category, position: input.position },
      ),
    onSuccess: () => invalidateBoards(queryClient, projectId),
  })
}

export const useDeleteColumn = (projectId: string, boardId: string) => {
  const apiClient = useApiClient()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (columnId: string) =>
      apiClient.delete<{ ok: true }>(
        `/api/projects/${projectId}/boards/${boardId}/columns/${columnId}`,
      ),
    onSuccess: () => invalidateBoards(queryClient, projectId),
  })
}
