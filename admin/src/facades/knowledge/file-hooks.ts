import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useApiClient } from '../../providers/ApiClientProvider'
import { useAuthSession } from '../../providers/AuthSessionProvider'
import type { AttachmentRecord } from '../../lib/uploads'
import { uploadFileWithProgress, type UploadProgress } from '../../lib/upload-xhr'
import type { KnowledgePageRecord, KnowledgeVersionRecord } from './hooks'

export type StorageUsage = { usedBytes: string; limitBytes: string | null }
export type StorageScopeType = 'organization' | 'project' | 'team' | 'space' | 'uploader'

const pagesKey = (spaceId?: string) => ['knowledge-pages', spaceId ?? 'none'] as const
const versionsKey = (pageId?: string) => ['knowledge-versions', pageId ?? 'none'] as const
const pageKey = (pageId?: string) => ['knowledge-page', pageId ?? 'none'] as const
export const pageAttachmentsKey = (pageId?: string) =>
  ['knowledge-page-attachments', pageId ?? 'none'] as const
const storageUsageKey = (scopeType: string, scopeId?: string) =>
  ['knowledge-storage-usage', scopeType, scopeId ?? 'self'] as const

export const versionDownloadPath = (pageId: string, versionId: string): string =>
  `/api/knowledge-base/pages/${pageId}/versions/${versionId}/download`

export const kbAttachmentDownloadPath = (attachmentId: string): string =>
  `/api/knowledge-base/attachments/${attachmentId}/download`

type UploadVars = { file: File; onProgress?: (progress: UploadProgress) => void }

// Create a file node in a space (optionally inside a folder page).
export const useUploadFileNode = (spaceId?: string, parentPageId?: string | null) => {
  const { token } = useAuthSession()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ file, onProgress }: UploadVars) => {
      const query = parentPageId ? `?parentPageId=${encodeURIComponent(parentPageId)}` : ''
      return uploadFileWithProgress<KnowledgePageRecord>(
        `/api/knowledge-base/spaces/${spaceId}/files${query}`,
        file,
        token,
        onProgress,
      )
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: pagesKey(spaceId) })
    },
  })
}

// Upload a new version of an existing file node.
export const useUploadFileVersion = (pageId?: string, spaceId?: string) => {
  const { token } = useAuthSession()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ file, onProgress }: UploadVars) =>
      uploadFileWithProgress<KnowledgeVersionRecord>(
        `/api/knowledge-base/pages/${pageId}/file-version`,
        file,
        token,
        onProgress,
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: versionsKey(pageId) })
      void queryClient.invalidateQueries({ queryKey: pageKey(pageId) })
      if (spaceId) void queryClient.invalidateQueries({ queryKey: pagesKey(spaceId) })
    },
  })
}

export const usePageAttachments = (pageId?: string) => {
  const apiClient = useApiClient()
  return useQuery<AttachmentRecord[]>({
    queryKey: pageAttachmentsKey(pageId),
    queryFn: () => apiClient.get(`/api/knowledge-base/pages/${pageId}/attachments`),
    enabled: Boolean(pageId),
  })
}

export const useUploadPageAttachment = (pageId?: string) => {
  const { token } = useAuthSession()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ file, onProgress }: UploadVars) =>
      uploadFileWithProgress<AttachmentRecord>(
        `/api/knowledge-base/pages/${pageId}/attachments`,
        file,
        token,
        onProgress,
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: pageAttachmentsKey(pageId) })
    },
  })
}

export const useDeleteAttachment = (pageId?: string) => {
  const apiClient = useApiClient()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (attachmentId: string) =>
      apiClient.delete(`/api/knowledge-base/attachments/${attachmentId}`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: pageAttachmentsKey(pageId) })
    },
  })
}

export const useStorageUsage = (scopeType: StorageScopeType = 'organization', scopeId?: string) => {
  const apiClient = useApiClient()
  return useQuery<StorageUsage>({
    queryKey: storageUsageKey(scopeType, scopeId),
    queryFn: () => {
      const params = new URLSearchParams({ scopeType })
      if (scopeId) params.set('scopeId', scopeId)
      return apiClient.get(`/api/knowledge-base/storage-usage?${params.toString()}`)
    },
  })
}
