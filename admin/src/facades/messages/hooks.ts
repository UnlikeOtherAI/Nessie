import { useMutation, useQueryClient } from '@tanstack/react-query'
import type { ThreadMessageRecord } from '../../lib/api-client'
import { uploadAttachment, type AttachmentRecord } from '../../lib/uploads'
import { useApiClient } from '../../providers/ApiClientProvider'
import { useAuthSession } from '../../providers/AuthSessionProvider'

export const useSendMessage = (threadId?: string) => {
  const apiClient = useApiClient()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (input: { content: string; attachmentIds?: string[] }) =>
      apiClient.post<ThreadMessageRecord>(`/api/threads/${threadId}/messages`, input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['threads', threadId, 'messages'] })
    },
  })
}

// Upload a file (multipart) and return the created attachment record. Uses the
// raw fetch helper because the JSON ApiClient cannot send FormData bodies.
export const useUploadAttachment = () => {
  const { token } = useAuthSession()
  return useMutation({
    mutationFn: (file: File): Promise<AttachmentRecord> => uploadAttachment(file, token),
  })
}
