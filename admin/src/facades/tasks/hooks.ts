import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useApiClient } from '../../providers/ApiClientProvider'

export type TaskStatus =
  | 'inbox'
  | 'assigned'
  | 'in_progress'
  | 'review'
  | 'done'
  | 'failed'
  | 'cancelled'
  | 'awaiting_approval'

export type TaskRecord = {
  id: string
  projectId: string | null
  status: TaskStatus
  title: string | null
  purpose: string | null
  assigneeUserId: string | null
  assigneeName: string | null
  ownerName: string | null
  createdAt: string
  updatedAt: string
}

export type AssignableUser = {
  id: string
  displayName: string
}

// All task queries share the ['tasks', …] prefix so a single invalidate or
// optimistic write reaches every board (aggregate + per-project) at once.
const tasksKey = (projectId?: string) => ['tasks', projectId ?? 'all'] as const

export const useTasks = (projectId?: string) => {
  const apiClient = useApiClient()
  return useQuery<TaskRecord[]>({
    queryKey: tasksKey(projectId),
    queryFn: () => apiClient.get(`/api/tasks${projectId ? `?project=${projectId}` : ''}`),
  })
}

export const useTaskAssignees = () => {
  const apiClient = useApiClient()
  return useQuery<AssignableUser[]>({
    queryKey: ['task-assignees'],
    queryFn: () => apiClient.get('/api/tasks/assignees'),
  })
}

export const useCreateTask = () => {
  const apiClient = useApiClient()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: {
      title: string
      purpose?: string
      projectId?: string
      assigneeUserId?: string
    }) => apiClient.post<TaskRecord>('/api/tasks', input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['tasks'] })
    },
  })
}

export const useAssignTask = () => {
  const apiClient = useApiClient()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: { id: string; assigneeUserId: string | null }) =>
      apiClient.post<TaskRecord>(`/api/tasks/${input.id}/assign`, {
        assigneeUserId: input.assigneeUserId,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['tasks'] })
    },
  })
}

type TransitionContext = { snapshots: [readonly unknown[], TaskRecord[] | undefined][] }

export const useTransitionTask = () => {
  const apiClient = useApiClient()
  const queryClient = useQueryClient()
  return useMutation<TaskRecord, Error, { id: string; status: TaskStatus }, TransitionContext>({
    mutationFn: (input) =>
      apiClient.post<TaskRecord>(`/api/tasks/${input.id}/transition`, { status: input.status }),
    // Optimistically move the dragged card across columns so the board feels
    // instant; roll back on failure (e.g. a transition the API rejects).
    onMutate: async (input) => {
      await queryClient.cancelQueries({ queryKey: ['tasks'] })
      const snapshots = queryClient.getQueriesData<TaskRecord[]>({ queryKey: ['tasks'] })
      for (const [key, data] of snapshots) {
        if (!data) continue
        queryClient.setQueryData(
          key,
          data.map((task) => (task.id === input.id ? { ...task, status: input.status } : task)),
        )
      }
      return { snapshots }
    },
    onError: (_error, _input, context) => {
      context?.snapshots.forEach(([key, data]) => queryClient.setQueryData(key, data))
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ['tasks'] })
    },
  })
}
