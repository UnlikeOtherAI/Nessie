import { useCallback } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  MESSAGE_UPLOAD_MAX_BYTES,
  type TaskAttachmentList,
  type TaskAttachmentRecord,
} from '@nessie/schemas'
import { taskKeys } from '../tasks/keys'
import { useApiClient } from '../../providers/ApiClientProvider'
import { useAuthSession } from '../../providers/AuthSessionProvider'
import {
  formatBytes,
  startFileUpload,
  type UploadProgress,
  type UploadStart,
} from '../../lib/upload-xhr'
import type { AttachmentRecord } from '../../lib/uploads'

export type { TaskAttachmentList, TaskAttachmentRecord }

/** The one upload door's own cap (`POST /api/uploads`), checked before sending. */
export const TASK_UPLOAD_MAX_BYTES = MESSAGE_UPLOAD_MAX_BYTES

/**
 * Stored files and external assets on a ticket, newest first.
 *
 * Kept as the route's `{ attachments }` envelope, never as a bare array: the
 * key nests under ['tasks'], and the board's optimistic sweep rewrites every
 * array it finds there as TaskRecord[].
 */
export const useTaskAttachments = (taskId?: string) => {
  const apiClient = useApiClient()
  return useQuery<TaskAttachmentList, Error, TaskAttachmentRecord[]>({
    // Identity boundary: a file list is the previous ticket's material, so it
    // is never replayed under another ticket. Only this ticket's own last
    // answer may stand in while it refetches.
    placeholderData: (previous, previousQuery) =>
      previousQuery?.queryKey[2] === taskId ? previous : undefined,
    queryKey: taskKeys.attachments(taskId),
    queryFn: () => apiClient.get<TaskAttachmentList>(`/api/tasks/${taskId}/attachments`),
    select: (data) => data.attachments,
    enabled: Boolean(taskId),
  })
}

const invalidateActivity = (queryClient: ReturnType<typeof useQueryClient>) => {
  // The list, the comments that cite files and the cards' counts all sit
  // under the task root.
  void queryClient.invalidateQueries({ queryKey: taskKeys.all })
}

/** Link the viewer's own finished uploads to a ticket; answers what linked. */
export const useLinkTaskAttachments = (taskId: string) => {
  const apiClient = useApiClient()
  const queryClient = useQueryClient()
  return useMutation<TaskAttachmentList, Error, string[]>({
    mutationFn: (attachmentIds) =>
      apiClient.post<TaskAttachmentList>(`/api/tasks/${taskId}/attachments`, { attachmentIds }),
    onSuccess: () => invalidateActivity(queryClient),
  })
}

export const useRemoveTaskAttachment = (taskId: string) => {
  const apiClient = useApiClient()
  const queryClient = useQueryClient()
  return useMutation<null, Error, string>({
    mutationFn: (attachmentId) =>
      apiClient.delete<null>(`/api/tasks/${taskId}/attachments/${attachmentId}`),
    onSuccess: () => invalidateActivity(queryClient),
  })
}

/** Thrown before any bytes move when a file is over the upload door's cap. */
export class TaskUploadTooLargeError extends Error {
  constructor(readonly filename: string) {
    super(`${filename} is larger than ${formatBytes(TASK_UPLOAD_MAX_BYTES)}`)
    this.name = 'TaskUploadTooLargeError'
  }
}

export type TaskUploadOptions = {
  onProgress?: (progress: UploadProgress) => void
  /**
   * Link to this ticket the moment the bytes land (edit mode: the file is on
   * the ticket even if the dialog closes unsaved). Omit in create mode, where
   * the id rides the create call's `attachmentIds`.
   */
  taskId?: string
}

/**
 * The one client path for a ticket file: `POST /api/uploads` with progress,
 * then — with a `taskId` — `POST /api/tasks/:taskId/attachments`. Returns the
 * upload's handle so a row can offer Cancel (`UploadAbortedError`).
 *
 * A link that fails leaves an unlinked upload of the viewer's own, which is
 * exactly the state create mode keeps on purpose; the caller surfaces the
 * error and the file can be discarded or linked again.
 */
export const useStartTaskUpload = () => {
  const { token } = useAuthSession()
  const apiClient = useApiClient()
  const queryClient = useQueryClient()
  return useCallback(
    (file: File, options: TaskUploadOptions = {}): UploadStart<AttachmentRecord> => {
      if (file.size > TASK_UPLOAD_MAX_BYTES) {
        const result = Promise.reject(new TaskUploadTooLargeError(file.name))
        // Handled by whoever awaits `result`; this only stops an unhandled
        // rejection when nobody does.
        result.catch(() => undefined)
        return { abort: () => undefined, result, xhr: new XMLHttpRequest() }
      }
      const started = startFileUpload<AttachmentRecord>({
        file,
        onProgress: options.onProgress,
        path: '/api/uploads',
        token,
      })
      const taskId = options.taskId
      if (!taskId) return started
      return {
        ...started,
        result: started.result.then(async (attachment) => {
          await apiClient.post<TaskAttachmentList>(`/api/tasks/${taskId}/attachments`, {
            attachmentIds: [attachment.id],
          })
          invalidateActivity(queryClient)
          return attachment
        }),
      }
    },
    [apiClient, queryClient, token],
  )
}

/**
 * The `MarkdownEditor`'s `onUploadImage` for a ticket: upload, link in edit
 * mode, and answer the id the editor writes as `![alt](/api/attachments/<id>)`.
 */
export const useTaskImageUpload = (taskId?: string) => {
  const start = useStartTaskUpload()
  return useCallback(
    async (file: File, onProgress?: (progress: UploadProgress) => void): Promise<{ id: string }> => {
      const attachment = await start(file, { onProgress, taskId }).result
      return { id: attachment.id }
    },
    [start, taskId],
  )
}
