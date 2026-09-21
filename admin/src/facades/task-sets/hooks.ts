import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  TaskSetItemRecordSchema,
  TaskSetProcessorOptionSchema,
  TaskSetRecordSchema,
  type TaskSetAction,
  type TaskSetCreate,
  type TaskSetItemInput,
  type TaskSetItemUpdate,
  type TaskSetUpdate,
} from '@nessie/schemas'
import { useApiClient } from '../../providers/ApiClientProvider'
import { taskSetKeys } from './keys'

export const useTaskSetProcessors = () => {
  const api = useApiClient()
  return useQuery({
    queryKey: taskSetKeys.processors,
    queryFn: () => api.get('/api/task-sets/processors', TaskSetProcessorOptionSchema.array()),
  })
}

export const useTaskSet = (id?: string) => {
  const api = useApiClient()
  return useQuery({
    enabled: Boolean(id),
    queryKey: taskSetKeys.detail(id),
    refetchInterval: (query) => {
      const set = query.state.data
      return set && (['running', 'waiting', 'importing'].includes(set.status)
        || set.currentItemId || set.deliveryStatus === 'pending') ? 5_000 : false
    },
    // A different workload can carry a different private disclosure basis.
    // Never paint the preceding set's input or results under a new identity.
    queryFn: () => api.get(`/api/task-sets/${id}`, TaskSetRecordSchema),
  })
}

export const useTaskSetItem = (setId: string, itemId?: string) => {
  const api = useApiClient()
  return useQuery({
    enabled: Boolean(itemId),
    queryKey: taskSetKeys.item(setId, itemId),
    queryFn: () => api.get(`/api/task-sets/${setId}/items/${itemId}`, TaskSetItemRecordSchema),
  })
}

export const useCreateTaskSet = () => {
  const api = useApiClient()
  const cache = useQueryClient()
  return useMutation({
    mutationFn: (input: TaskSetCreate) =>
      api.post('/api/task-sets', input, undefined, TaskSetRecordSchema),
    onSuccess: () => cache.invalidateQueries({ queryKey: taskSetKeys.all }),
  })
}

export const useUpdateTaskSet = (id: string) => {
  const api = useApiClient()
  const cache = useQueryClient()
  return useMutation({
    mutationFn: (input: TaskSetUpdate) =>
      api.patch(`/api/task-sets/${id}`, input, undefined, TaskSetRecordSchema),
    onSuccess: () => cache.invalidateQueries({ queryKey: taskSetKeys.all }),
  })
}

export const useTaskSetAction = (id: string) => {
  const api = useApiClient()
  const cache = useQueryClient()
  return useMutation({
    mutationFn: (input: TaskSetAction) =>
      api.post(`/api/task-sets/${id}/actions`, input, undefined, TaskSetRecordSchema),
    onSuccess: () => cache.invalidateQueries({ queryKey: taskSetKeys.all }),
  })
}

export const useAddTaskSetItem = (id: string) => {
  const api = useApiClient()
  const cache = useQueryClient()
  return useMutation({
    mutationFn: (input: TaskSetItemInput) =>
      api.post(`/api/task-sets/${id}/items`, { items: [input] }, undefined, TaskSetItemRecordSchema.array()),
    onSuccess: () => cache.invalidateQueries({ queryKey: taskSetKeys.all }),
  })
}

export const useUpdateTaskSetItem = (setId: string, itemId: string) => {
  const api = useApiClient()
  const cache = useQueryClient()
  return useMutation({
    mutationFn: (input: TaskSetItemUpdate) =>
      api.patch(`/api/task-sets/${setId}/items/${itemId}`, input, undefined, TaskSetItemRecordSchema),
    onSuccess: () => cache.invalidateQueries({ queryKey: taskSetKeys.all }),
  })
}
