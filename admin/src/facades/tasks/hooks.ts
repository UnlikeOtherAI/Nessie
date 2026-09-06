import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type {
  TaskPriority,
  TaskRecord as SharedTaskRecord,
  TaskStatus,
} from '@nessie/schemas'

import { iterationKeys } from '../iterations/keys'
import { taskKeys } from './keys'
import { useApiClient } from '../../providers/ApiClientProvider'

export type { TaskPriority, TaskStatus }

// The server-enforced shape (`TaskRecordSchema`, parsed on every response in
// `api/src/routes/tasks.ts`) rather than a hand-copied type, so a field the
// server adds (organizationId, agentId, parentTaskId, runId, ownerUserId,
// createdByUserId, …) reaches this client automatically instead of silently
// drifting out of the hand-written copy.
export type TaskRecord = SharedTaskRecord

export type AssignableUser = {
  id: string
  displayName: string
}

export const useTasks = (projectId?: string) => {
  const apiClient = useApiClient()
  return useQuery<TaskRecord[]>({
    placeholderData: keepPreviousData,
    queryKey: taskKeys.forProject(projectId),
    queryFn: () => apiClient.get(`/api/tasks${projectId ? `?project=${projectId}` : ''}`),
  })
}

export const useTaskAssignees = () => {
  const apiClient = useApiClient()
  return useQuery<AssignableUser[]>({
    queryKey: taskKeys.assignees,
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
      detail?: string
      projectId?: string
      /** The board the card lands on; absent ⇒ the project's default board. */
      boardId?: string
      iterationId?: string
      storyPoints?: number
      priority?: TaskPriority
      dueDate?: string | null
      assigneeUserId?: string
      assigneeAgentId?: string
    }) => apiClient.post<TaskRecord>('/api/tasks', input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: taskKeys.all })
    },
  })
}

// Partial edit of a task's human-editable fields (title, excerpt, priority,
// deadline). Assignment and status keep their own endpoints — the dialog calls
// those separately.
export const useUpdateTask = () => {
  const apiClient = useApiClient()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: {
      id: string
      title?: string
      purpose?: string | null
      detail?: string | null
      priority?: TaskPriority
      dueDate?: string | null
      archivedAt?: string | null
      /** A partial merge of custom field values; `null` clears one. */
      fieldValues?: Record<string, unknown>
    }) => {
      const { id, ...fields } = input
      return apiClient.patch<TaskRecord>(`/api/tasks/${id}`, fields)
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: taskKeys.all })
      void queryClient.invalidateQueries({ queryKey: iterationKeys.all })
    },
  })
}

export const useArchiveDoneTasks = () => {
  const apiClient = useApiClient()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: {
      projectId: string
      /** The board whose Done column was clicked; its tickets only. */
      boardId?: string
      olderThanDays?: number | null
    }) => apiClient.post<{ count: number }>('/api/tasks/archive-done', input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: taskKeys.all })
      void queryClient.invalidateQueries({ queryKey: iterationKeys.all })
    },
  })
}

export const useSetTaskIteration = () => {
  const apiClient = useApiClient()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: { id: string; iterationId: string | null }) =>
      apiClient.post<TaskRecord>(`/api/tasks/${input.id}/iteration`, {
        iterationId: input.iterationId,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: taskKeys.all })
      void queryClient.invalidateQueries({ queryKey: iterationKeys.all })
    },
  })
}

export const useUpdateTaskPoints = () => {
  const apiClient = useApiClient()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: { id: string; storyPoints: number | null }) =>
      apiClient.patch<TaskRecord>(`/api/tasks/${input.id}`, { storyPoints: input.storyPoints }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: taskKeys.all })
      void queryClient.invalidateQueries({ queryKey: iterationKeys.all })
    },
  })
}

export const useAssignTask = () => {
  const apiClient = useApiClient()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: {
      id: string
      assigneeUserId?: string | null
      assigneeAgentId?: string | null
    }) =>
      apiClient.post<TaskRecord>(`/api/tasks/${input.id}/assign`, {
        assigneeUserId: input.assigneeUserId ?? null,
        assigneeAgentId: input.assigneeAgentId ?? null,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: taskKeys.all })
    },
  })
}

type OptimisticContext = { snapshots: [readonly unknown[], TaskRecord[] | undefined][] }

// Optimistically patch the matching task across every per-project cache so the
// board reacts instantly; returns the snapshots for rollback on error.
const optimisticPatch = (
  queryClient: ReturnType<typeof useQueryClient>,
  id: string,
  patch: Partial<TaskRecord>,
): OptimisticContext => {
  const snapshots = queryClient.getQueriesData<TaskRecord[]>({ queryKey: taskKeys.all })
  for (const [key, data] of snapshots) {
    if (!data) continue
    queryClient.setQueryData(
      key,
      data.map((task) => (task.id === id ? { ...task, ...patch } : task)),
    )
  }
  return { snapshots }
}

// No optimistic cache patch: the board keeps a local ordered copy for instant
// feedback while dragging, and an optimistic field-only patch (no array reorder)
// would briefly fight the dropped order. We just persist and refetch.
export const useMoveTask = () => {
  const apiClient = useApiClient()
  const queryClient = useQueryClient()
  return useMutation<TaskRecord, Error, { id: string; columnId: string; position?: number }>({
    mutationFn: (input) =>
      apiClient.post<TaskRecord>(`/api/tasks/${input.id}/move`, {
        columnId: input.columnId,
        position: input.position,
      }),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: taskKeys.all })
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
      await queryClient.cancelQueries({ queryKey: taskKeys.all })
      return optimisticPatch(queryClient, input.id, { status: input.status })
    },
    onError: (_error, _input, context) => {
      context?.snapshots.forEach(([key, data]) => queryClient.setQueryData(key, data))
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: taskKeys.all })
    },
  })
}
