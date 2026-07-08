import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useApiClient } from '../../providers/ApiClientProvider'
import { useAuthSession } from '../../providers/AuthSessionProvider'
import { uploadFileWithProgress, type UploadProgress } from '../../lib/upload-xhr'
import type { KnowledgePageRecord } from './hooks'

// The ticket "Documents" tab: a task's bound knowledge pages (notes stored in
// the project's "Project Documents" space, plus uploaded file nodes).
const taskPagesKey = (taskId?: string) => ['task-pages', taskId ?? 'none'] as const

export const useTaskPages = (taskId?: string) => {
  const apiClient = useApiClient()

  return useQuery<KnowledgePageRecord[]>({
    queryKey: taskPagesKey(taskId),
    queryFn: () => apiClient.get(`/api/knowledge-base/tasks/${taskId}/pages`),
    enabled: Boolean(taskId),
  })
}

export const useCreateTaskPage = (taskId?: string) => {
  const apiClient = useApiClient()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (input: { title: string; body?: string }) =>
      apiClient.post<KnowledgePageRecord>(`/api/knowledge-base/tasks/${taskId}/pages`, input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: taskPagesKey(taskId) })
    },
  })
}

type UploadVars = { file: File; onProgress?: (progress: UploadProgress) => void }

export const useUploadTaskFile = (taskId?: string) => {
  const { token } = useAuthSession()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: ({ file, onProgress }: UploadVars) =>
      uploadFileWithProgress<KnowledgePageRecord>(
        `/api/knowledge-base/tasks/${taskId}/files`,
        file,
        token,
        onProgress,
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: taskPagesKey(taskId) })
    },
  })
}
