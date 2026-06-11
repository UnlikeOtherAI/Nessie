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
  columnId: string | null
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

type OptimisticContext = { snapshots: [readonly unknown[], TaskRecord[] | undefined][] }

// Optimistically patch the matching task across every ['tasks', …] cache so the
// board reacts instantly; returns the snapshots for rollback on error.
const optimisticPatch = (
  queryClient: ReturnType<typeof useQueryClient>,
  id: string,
  patch: Partial<TaskRecord>,
): OptimisticContext => {
  const snapshots = queryClient.getQueriesData<TaskRecord[]>({ queryKey: ['tasks'] })
  for (const [key, data] of snapshots) {
    if (!data) continue
    queryClient.setQueryData(
      key,
      data.map((task) => (task.id === id ? { ...task, ...patch } : task)),
    )
  }
  return { snapshots }
}

export const useMoveTask = () => {
  const apiClient = useApiClient()
  const queryClient = useQueryClient()
  return useMutation<TaskRecord, Error, { id: string; columnId: string }, OptimisticContext>({
    mutationFn: (input) =>
      apiClient.post<TaskRecord>(`/api/tasks/${input.id}/move`, { columnId: input.columnId }),
    onMutate: async (input) => {
      await queryClient.cancelQueries({ queryKey: ['tasks'] })
      return optimisticPatch(queryClient, input.id, { columnId: input.columnId })
    },
    onError: (_error, _input, context) => {
      context?.snapshots.forEach(([key, data]) => queryClient.setQueryData(key, data))
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ['tasks'] })
    },
  })
}

type TransitionContext = OptimisticContext

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
      return optimisticPatch(queryClient, input.id, { status: input.status })
    },
    onError: (_error, _input, context) => {
      context?.snapshots.forEach(([key, data]) => queryClient.setQueryData(key, data))
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ['tasks'] })
    },
  })
}
