import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useApiClient } from '../../providers/ApiClientProvider'

export type ColumnCategory = 'todo' | 'in_progress' | 'review' | 'done'
export type BoardStyle = 'kanban' | 'scrum'

export type BoardColumn = {
  id: string
  projectId: string
  name: string
  category: ColumnCategory
  position: number
}

export type ProjectBoard = {
  style: BoardStyle
  columns: BoardColumn[]
}

const boardKey = (projectId: string) => ['project-board', projectId] as const

export const useProjectBoard = (projectId?: string) => {
  const apiClient = useApiClient()
  return useQuery<ProjectBoard>({
    queryKey: ['project-board', projectId ?? ''],
    queryFn: () => apiClient.get(`/api/projects/${projectId}/board`),
    enabled: Boolean(projectId),
  })
}

export const useSetBoardStyle = (projectId: string) => {
  const apiClient = useApiClient()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (style: BoardStyle) =>
      apiClient.patch<ProjectBoard>(`/api/projects/${projectId}/board`, { style }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: boardKey(projectId) })
      void queryClient.invalidateQueries({ queryKey: ['projects'] })
    },
  })
}

export const useCreateColumn = (projectId: string) => {
  const apiClient = useApiClient()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: { name: string; category: ColumnCategory }) =>
      apiClient.post<BoardColumn>(`/api/projects/${projectId}/columns`, input),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: boardKey(projectId) }),
  })
}

export const useUpdateColumn = (projectId: string) => {
  const apiClient = useApiClient()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: { id: string; name?: string; category?: ColumnCategory; position?: number }) =>
      apiClient.patch<BoardColumn>(`/api/projects/${projectId}/columns/${input.id}`, {
        name: input.name,
        category: input.category,
        position: input.position,
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: boardKey(projectId) }),
  })
}

export const useDeleteColumn = (projectId: string) => {
  const apiClient = useApiClient()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (columnId: string) =>
      apiClient.delete<{ ok: true }>(`/api/projects/${projectId}/columns/${columnId}`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: boardKey(projectId) })
      void queryClient.invalidateQueries({ queryKey: ['tasks'] })
    },
  })
}
