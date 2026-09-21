import {
  useInfiniteQuery,
  useMutation,
  useQueryClient,
  type InfiniteData,
} from '@tanstack/react-query'
import type {
  CreateTaskCommentBody,
  TaskCommentList,
  TaskCommentRecord,
} from '@nessie/schemas'
import { taskKeys } from '../tasks/keys'
import { useApiClient } from '../../providers/ApiClientProvider'

export type { TaskCommentList, TaskCommentRecord }

/** One page of the route's keyset; the section asks for 50 at a time. */
export const TASK_COMMENTS_PAGE_SIZE = 50

export const taskCommentsPath = (taskId: string, cursor: string | null): string => {
  const search = new URLSearchParams({ limit: String(TASK_COMMENTS_PAGE_SIZE) })
  if (cursor) search.set('cursor', cursor)
  return `/api/tasks/${taskId}/comments?${search.toString()}`
}

/**
 * Every loaded comment in the order the route pages them (oldest first):
 * page one, then each page `nextCursor` fetched after it.
 */
export const flattenTaskComments = (
  data: InfiniteData<TaskCommentList, unknown> | undefined,
): TaskCommentRecord[] => data?.pages.flatMap((page) => page.comments) ?? []

/**
 * A ticket's comments. No `placeholderData`: comment bodies are the previous
 * ticket's private discussion, so a new ticket loads empty first rather than
 * replaying them under its own title (the checklist's reasoning in
 * `facades/tasks/hooks.ts`).
 */
export const useTaskComments = (taskId?: string) => {
  const apiClient = useApiClient()
  const query = useInfiniteQuery({
    queryKey: taskKeys.comments(taskId),
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) =>
      apiClient.get<TaskCommentList>(taskCommentsPath(taskId ?? '', pageParam)),
    getNextPageParam: (lastPage) => lastPage.nextCursor,
    enabled: Boolean(taskId),
  })
  const firstPage = query.data?.pages[0]
  return {
    ...query,
    comments: flattenTaskComments(query.data),
    /** Live (not deleted) comments on the ticket, whether loaded or not. */
    total: firstPage?.total ?? 0,
  }
}

const invalidateActivity = (queryClient: ReturnType<typeof useQueryClient>) => {
  // `comments` and `attachments` nest under the root, and the card's
  // `commentCount` / `attachmentCount` live on the board lists beside them,
  // so one invalidate reaches all three.
  void queryClient.invalidateQueries({ queryKey: taskKeys.all })
}

export const useCreateTaskComment = (taskId: string) => {
  const apiClient = useApiClient()
  const queryClient = useQueryClient()
  return useMutation<TaskCommentRecord, Error, CreateTaskCommentBody>({
    mutationFn: (body) => apiClient.post<TaskCommentRecord>(`/api/tasks/${taskId}/comments`, body),
    onSuccess: () => invalidateActivity(queryClient),
  })
}

export const useUpdateTaskComment = (taskId: string) => {
  const apiClient = useApiClient()
  const queryClient = useQueryClient()
  return useMutation<TaskCommentRecord, Error, { commentId: string; body: string }>({
    mutationFn: ({ commentId, body }) =>
      apiClient.patch<TaskCommentRecord>(`/api/tasks/${taskId}/comments/${commentId}`, { body }),
    onSuccess: () => invalidateActivity(queryClient),
  })
}

export const useDeleteTaskComment = (taskId: string) => {
  const apiClient = useApiClient()
  const queryClient = useQueryClient()
  return useMutation<null, Error, string>({
    mutationFn: (commentId) =>
      apiClient.delete<null>(`/api/tasks/${taskId}/comments/${commentId}`),
    onSuccess: () => invalidateActivity(queryClient),
  })
}
