import { useCallback, useMemo, useRef, useState } from 'react'
import { MESSAGE_ATTACHMENT_LIMIT, MESSAGE_UPLOAD_MAX_BYTES } from '@nessie/schemas'
import { useDiscardAttachment } from '../../../facades/messages/hooks'
import { formatBytes, uploadFileWithProgress } from '../../../lib/upload-xhr'
import type { AttachmentRecord } from '../../../lib/uploads'
import { useAuthSession } from '../../../providers/AuthSessionProvider'

/** One file staged in the composer, from picked to uploaded (or failed). */
export type StagedAttachment = {
  clientId: string
  filename: string
  sizeBytes: number
  pct: number
  status: 'uploading' | 'done' | 'error'
  attachmentId?: string
  error?: string
}

export type ComposerAttachments = {
  staged: StagedAttachment[]
  /** Client-side validation message (too large / too many). */
  error: string | null
  isUploading: boolean
  /** Ids of finished uploads, in staging order — the message payload. */
  attachmentIds: string[]
  addFiles: (files: File[]) => void
  removeStaged: (clientId: string) => void
  clearStaged: () => void
}

const newClientId = (): string =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random()}`

// The upload helper rejects with the raw response body; surface the API's own
// message (quota, size) when there is one instead of a JSON blob.
const describeUploadError = (error: unknown): string => {
  const raw = error instanceof Error ? error.message : String(error)
  try {
    const payload = JSON.parse(raw) as { error?: { message?: string } }
    if (payload.error?.message) {
      return payload.error.message
    }
  } catch {
    // Not JSON — fall through to the raw text.
  }
  return raw || 'Upload failed'
}

/**
 * Staged-attachment state for the message composer: client-side validation,
 * per-file upload with progress, and removal (which discards the uploaded
 * bytes server-side, so an attachment picked and then removed never lingers).
 *
 * The list is cleared by the composer only after a successful send, so a failed
 * send keeps the files for a retry.
 */
export const useComposerAttachments = (): ComposerAttachments => {
  const { token } = useAuthSession()
  const discardAttachment = useDiscardAttachment()
  const [staged, setStaged] = useState<StagedAttachment[]>([])
  const [error, setError] = useState<string | null>(null)
  // Mirrors `staged` so capacity checks and concurrent progress updates read a
  // synchronous, always-current list.
  const stagedRef = useRef<StagedAttachment[]>([])
  // Entries removed while their upload was still in flight: the finished upload
  // is discarded instead of landing back in the list.
  const abandoned = useRef(new Set<string>())

  const discard = discardAttachment.mutateAsync

  const applyStaged = useCallback(
    (update: (current: StagedAttachment[]) => StagedAttachment[]) => {
      stagedRef.current = update(stagedRef.current)
      setStaged(stagedRef.current)
    },
    [],
  )

  const patchStaged = useCallback(
    (clientId: string, patch: Partial<StagedAttachment>) => {
      applyStaged((current) =>
        current.map((entry) => (entry.clientId === clientId ? { ...entry, ...patch } : entry)),
      )
    },
    [applyStaged],
  )

  const startUpload = useCallback(
    async (clientId: string, file: File) => {
      try {
        const attachment = await uploadFileWithProgress<AttachmentRecord>(
          '/api/uploads',
          file,
          token,
          ({ pct }) => patchStaged(clientId, { pct }),
        )
        if (abandoned.current.delete(clientId)) {
          await discard(attachment.id).catch(() => undefined)
          return
        }
        patchStaged(clientId, { pct: 100, status: 'done', attachmentId: attachment.id })
      } catch (uploadError) {
        if (abandoned.current.delete(clientId)) {
          return
        }
        patchStaged(clientId, { status: 'error', error: describeUploadError(uploadError) })
      }
    },
    [discard, patchStaged, token],
  )

  const addFiles = useCallback(
    (files: File[]) => {
      if (files.length === 0) {
        return
      }
      const withinSize = files.filter((file) => file.size <= MESSAGE_UPLOAD_MAX_BYTES)
      const oversize = files.filter((file) => file.size > MESSAGE_UPLOAD_MAX_BYTES)
      const capacity = Math.max(MESSAGE_ATTACHMENT_LIMIT - stagedRef.current.length, 0)
      const accepted = withinSize.slice(0, capacity)

      const problems: string[] = []
      if (oversize.length > 0) {
        problems.push(
          `${oversize.map((file) => file.name).join(', ')} `
          + `${oversize.length === 1 ? 'is' : 'are'} larger than `
          + `${formatBytes(MESSAGE_UPLOAD_MAX_BYTES)}.`,
        )
      }
      if (accepted.length < withinSize.length) {
        problems.push(`You can attach up to ${MESSAGE_ATTACHMENT_LIMIT} files per message.`)
      }
      setError(problems.length > 0 ? problems.join(' ') : null)
      if (accepted.length === 0) {
        return
      }

      const queued = accepted.map((file) => ({
        file,
        entry: {
          clientId: newClientId(),
          filename: file.name,
          sizeBytes: file.size,
          pct: 0,
          status: 'uploading' as const,
        },
      }))
      applyStaged((current) => [...current, ...queued.map((item) => item.entry)])
      queued.forEach(({ entry, file }) => {
        void startUpload(entry.clientId, file)
      })
    },
    [applyStaged, startUpload],
  )

  const removeStaged = useCallback(
    (clientId: string) => {
      const entry = stagedRef.current.find((candidate) => candidate.clientId === clientId)
      applyStaged((current) => current.filter((candidate) => candidate.clientId !== clientId))
      setError(null)
      if (!entry) {
        return
      }
      if (entry.status === 'uploading') {
        abandoned.current.add(clientId)
        return
      }
      if (entry.attachmentId) {
        void discard(entry.attachmentId).catch(() => undefined)
      }
    },
    [applyStaged, discard],
  )

  const clearStaged = useCallback(() => {
    applyStaged(() => [])
    setError(null)
  }, [applyStaged])

  return useMemo(
    () => ({
      staged,
      error,
      isUploading: staged.some((entry) => entry.status === 'uploading'),
      attachmentIds: staged
        .filter((entry) => entry.status === 'done' && entry.attachmentId)
        .map((entry) => entry.attachmentId as string),
      addFiles,
      removeStaged,
      clearStaged,
    }),
    [addFiles, clearStaged, error, removeStaged, staged],
  )
}
