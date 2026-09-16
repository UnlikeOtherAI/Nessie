import { useEffect, useMemo, useRef } from 'react'
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { knowledgeKeys } from './keys'
import { useApiClient } from '../../providers/ApiClientProvider'
import { useAuthSession } from '../../providers/AuthSessionProvider'
import type { AttachmentRecord } from '../../lib/uploads'
import {
  startFileUpload,
  uploadFileWithProgress,
  type UploadProgress,
  type UploadStart,
} from '../../lib/upload-xhr'
import type { KnowledgePageRecord, KnowledgeVersionRecord } from './hooks'

export type StorageUsage = { usedBytes: string; limitBytes: string | null }
export type StorageScopeType = 'organization' | 'project' | 'team' | 'space' | 'uploader'

export const versionDownloadPath = (pageId: string, versionId: string): string =>
  `/api/knowledge-base/pages/${pageId}/versions/${versionId}/download`

export const kbAttachmentDownloadPath = (attachmentId: string): string =>
  `/api/knowledge-base/attachments/${attachmentId}/download`

type UploadVars = { baseVersionId?: string; file: File; onProgress?: (progress: UploadProgress) => void }

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
      void queryClient.invalidateQueries({ queryKey: knowledgeKeys.pages(spaceId) })
    },
  })
}

// Upload a new version of an existing file node.
export const useUploadFileVersion = (pageId?: string, spaceId?: string) => {
  const { token } = useAuthSession()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ baseVersionId, file, onProgress }: UploadVars) =>
      uploadFileWithProgress<KnowledgeVersionRecord>(
        `/api/knowledge-base/pages/${pageId}/file-version`,
        file,
        token,
        onProgress,
        baseVersionId ? { baseVersionId } : undefined,
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: knowledgeKeys.versions(pageId) })
      void queryClient.invalidateQueries({ queryKey: knowledgeKeys.page(pageId) })
      if (spaceId) void queryClient.invalidateQueries({ queryKey: knowledgeKeys.pages(spaceId) })
    },
  })
}

export type ZipEntry = {
  name: string
  size: number
  compressedSize: number
  isDirectory: boolean
  isText: boolean
}
export type ZipListing = { entries: ZipEntry[]; tooLarge: boolean }

// List a zip file node's contents (entries from its central directory).
export const useZipEntries = (pageId?: string, versionId?: string) => {
  const apiClient = useApiClient()
  return useQuery<ZipListing>({
    placeholderData: keepPreviousData,
    queryKey: knowledgeKeys.zip(pageId, versionId),
    queryFn: () =>
      apiClient.get(`/api/knowledge-base/pages/${pageId}/versions/${versionId}/zip`),
    enabled: Boolean(pageId && versionId),
  })
}

// Peek a single text entry inside a zip (decompresses just that entry).
export const useZipEntryText = (pageId?: string, versionId?: string, path?: string | null) => {
  const apiClient = useApiClient()
  return useQuery<{ text: string; truncated: boolean }>({
    placeholderData: keepPreviousData,
    queryKey: knowledgeKeys.zipEntry(pageId, versionId, path),
    queryFn: () =>
      apiClient.get(
        `/api/knowledge-base/pages/${pageId}/versions/${versionId}/zip/entry?path=${encodeURIComponent(path ?? '')}`,
      ),
    enabled: Boolean(pageId && versionId && path),
  })
}

export const usePageAttachments = (pageId?: string) => {
  const apiClient = useApiClient()
  return useQuery<AttachmentRecord[]>({
    placeholderData: keepPreviousData,
    queryKey: knowledgeKeys.attachments(pageId),
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
      void queryClient.invalidateQueries({ queryKey: knowledgeKeys.attachments(pageId) })
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
      void queryClient.invalidateQueries({ queryKey: knowledgeKeys.attachments(pageId) })
    },
  })
}

export const useStorageUsage = (scopeType: StorageScopeType = 'organization', scopeId?: string) => {
  const apiClient = useApiClient()
  return useQuery<StorageUsage>({
    placeholderData: keepPreviousData,
    queryKey: knowledgeKeys.storageUsage(scopeType, scopeId),
    queryFn: () => {
      const params = new URLSearchParams({ scopeType })
      if (scopeId) params.set('scopeId', scopeId)
      return apiClient.get(`/api/knowledge-base/storage-usage?${params.toString()}`)
    },
  })
}

// ── The Finder's upload queue (uploads-and-indexing.md §2) ──────────────────
//
// `useUploadFileNode` above is the one-file-at-a-time doorway every other
// surface uses. A queue needs three things that mutation cannot give it: the
// live request (to cancel it), the HTTP status behind a rejection (507 and 413
// mean different things to the person and to the rest of the queue), and a
// folder create that hands back the folder it made.

export type UploadFailureCode =
  | 'STORAGE_QUOTA_EXCEEDED'
  | 'FILE_TOO_LARGE'
  | 'NETWORK'
  | 'REFUSED'

export type UploadFailure = { code: UploadFailureCode; message: string }

/**
 * Which refusal this was. `startFileUpload` rejects with the server's own
 * sentence and nothing else, so the code comes off the request that carried
 * it — the status is the only place the distinction survives.
 *
 * A status of 0 is the transport, not the server: no response ever arrived.
 */
export const uploadFailureFrom = (error: unknown, status: number): UploadFailure => {
  const message = error instanceof Error ? error.message : 'Upload failed'
  if (status === 507) return { code: 'STORAGE_QUOTA_EXCEEDED', message }
  if (status === 413) return { code: 'FILE_TOO_LARGE', message }
  if (status === 0) return { code: 'NETWORK', message: 'Upload failed' }
  return { code: 'REFUSED', message }
}

export type StartUploadInput = {
  file: File
  onProgress?: (progress: UploadProgress) => void
  parentPageId: string | null
  spaceId: string
  /** The name to file it under; defaults to the file's own. */
  title?: string
}

/**
 * The queue's four calls, bound once. Passed into `useUploadQueue` rather than
 * imported by it, so the queue's ordering, concurrency and failure rules can
 * be driven by a test without an XMLHttpRequest.
 */
export type UploadDriver = {
  createFolder: (input: {
    parentPageId: string | null
    spaceId: string
    title: string
  }) => Promise<KnowledgePageRecord>
  /** A cancelled upload whose bytes already landed leaves a page behind. */
  deletePage: (pageId: string) => Promise<void>
  invalidateSpace: (spaceId: string) => void
  startUpload: (input: StartUploadInput) => UploadStart<KnowledgePageRecord>
}

export const useUploadDriver = (): UploadDriver => {
  const apiClient = useApiClient()
  const queryClient = useQueryClient()
  const { token } = useAuthSession()

  return useMemo(() => ({
    createFolder: ({ parentPageId, spaceId, title }) =>
      apiClient.post<KnowledgePageRecord>(
        `/api/knowledge-base/spaces/${spaceId}/pages`,
        { kind: 'folder', metadata: { folder: true }, parentPageId, title },
      ),
    deletePage: async (pageId) => {
      await apiClient.delete<KnowledgePageRecord>(`/api/knowledge-base/pages/${pageId}`)
    },
    invalidateSpace: (spaceId) => {
      void queryClient.invalidateQueries({ queryKey: knowledgeKeys.pages(spaceId) })
      void queryClient.invalidateQueries({ queryKey: knowledgeKeys.storageUsage('organization') })
    },
    startUpload: ({ file, onProgress, parentPageId, spaceId, title }) => {
      const params = new URLSearchParams()
      if (parentPageId) params.set('parentPageId', parentPageId)
      if (title) params.set('title', title)
      const query = params.toString()
      return startFileUpload<KnowledgePageRecord>({
        file,
        onProgress,
        path: `/api/knowledge-base/spaces/${spaceId}/files${query ? `?${query}` : ''}`,
        token,
      })
    },
  }), [apiClient, queryClient, token])
}

/**
 * Freshness for the indexing glyph, without a new realtime kind
 * (uploads-and-indexing.md §4). While the loaded list has a row the pipeline
 * is still working on, the list is re-read every 5 s; the moment none is, it
 * stops.
 *
 * `POLL_CEILING_MS` is the honesty valve: a job stuck behind a dead worker
 * would otherwise poll for the life of the tab. After ten minutes the asking
 * stops and the row keeps saying "Indexing…", which is true — something is
 * queued and nothing is happening — and is an operator's problem
 * (`queue_jobs` for `kb-extract:{pageId}:{versionId}`), not a row's.
 */
export const INDEXING_POLL_MS = 5_000
export const INDEXING_POLL_CEILING_MS = 10 * 60_000

export const useIndexingRefresh = (spaceId: string | undefined, pending: boolean): void => {
  const queryClient = useQueryClient()
  const startedAt = useRef<number | null>(null)

  useEffect(() => {
    if (!spaceId || !pending) {
      startedAt.current = null
      return
    }
    startedAt.current ??= Date.now()
    const timer = setInterval(() => {
      const since = startedAt.current
      if (since !== null && Date.now() - since > INDEXING_POLL_CEILING_MS) {
        clearInterval(timer)
        return
      }
      void queryClient.invalidateQueries({ queryKey: knowledgeKeys.pages(spaceId) })
    }, INDEXING_POLL_MS)
    return () => clearInterval(timer)
  }, [pending, queryClient, spaceId])
}
