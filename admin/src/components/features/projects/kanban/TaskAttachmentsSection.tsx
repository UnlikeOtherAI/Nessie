import { useCallback, useRef, useState } from 'react'
import {
  faArrowUpRightFromSquare,
  faDownload,
  faTriangleExclamation,
  faUpload,
  faXmark,
} from '@fortawesome/free-solid-svg-icons'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import type { TaskAttachmentRecord } from '@nessie/schemas'
import { Notice } from '../../../primitives/Notice'
import { Pill } from '../../../primitives/Pill'
import { SectionLabel } from '../../../primitives/SectionLabel'
import { Skeleton } from '../../../primitives/Skeleton'
import { canViewAttachment, useAttachmentViewer } from '../../../shared/AttachmentViewer'
import { ConfirmDialog } from '../../../shared/ConfirmDialog'
import { DropZoneOverlay } from '../../../shared/DropZoneOverlay'
import { UserAvatar } from '../../../shared/UserAvatar'
import { iconForFilename } from '../../../shared/file-icons'
import { useActorNames } from '../../../shared/ActorName'
import { PROVIDER_LABEL } from '../../../../facades/board-sources/hooks'
import {
  useRemoveTaskAttachment,
  useStartTaskUpload,
  useTaskAttachments,
} from '../../../../facades/task-attachments/hooks'
import { useFileDrop } from '../../../../hooks/useFileDrop'
import { formatBytes, isUploadAborted } from '../../../../lib/upload-xhr'
import { attachmentThumbnailPath, downloadAuthedPath, useAuthedObjectUrlFromPath } from '../../../../lib/uploads'
import { useAuthSession } from '../../../../providers/AuthSessionProvider'
import { ProviderTile, asAttachmentRecord, exactTime, relativeTime } from './TaskCommentRow'

type Uploading = { abort: () => void; error?: string; filename: string; key: string; pct: number }

const iconButtonClass = [
  'flex h-8 w-8 flex-none items-center justify-center rounded text-[color:var(--tx3)]',
  'hover:bg-[color:var(--overlay)] hover:text-[color:var(--tx)]',
].join(' ')

const rowClass = 'flex min-h-12 items-center gap-3 rounded-md px-2 py-1.5 hover:bg-[color:var(--overlay-weak)]'

const Thumbnail = ({ attachment, token }: { attachment: TaskAttachmentRecord; token: string | null }) => {
  const url = useAuthedObjectUrlFromPath(
    attachment.hasThumbnail && (!attachment.external || attachment.external.status === 'stored')
      ? attachmentThumbnailPath(attachment.id)
      : null,
    token,
  )
  return (
    <span className="flex h-10 w-10 flex-none items-center justify-center overflow-hidden rounded-md bg-[color:var(--overlay-weak)] text-[color:var(--tx3)]">
      {url ? (
        <img alt="" className="h-full w-full object-cover" src={url} />
      ) : attachment.external?.status === 'link' ? (
        <FontAwesomeIcon icon={faArrowUpRightFromSquare} />
      ) : attachment.external?.status === 'failed' ? (
        <FontAwesomeIcon className="text-[color:var(--warning-text)]" icon={faTriangleExclamation} />
      ) : (
        <FontAwesomeIcon icon={iconForFilename(attachment.filename)} />
      )}
    </span>
  )
}

const hostOf = (url: string): string => {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

/**
 * Files on the ticket (ui.md §5.5): uploaded here, dropped here, pasted into
 * the description or a comment, or copied in from the source. Uploads and
 * removals are immediate — the file is the ticket's the moment it lands, not
 * when *Save changes* is pressed.
 */
export const TaskAttachmentsSection = ({ canEdit, taskId }: { canEdit: boolean; taskId: string }) => {
  const { token } = useAuthSession()
  const resolveActor = useActorNames()
  const attachmentsQuery = useTaskAttachments(taskId)
  const startUpload = useStartTaskUpload()
  const removeAttachment = useRemoveTaskAttachment(taskId)
  const { attachmentViewer, openAttachment } = useAttachmentViewer(token)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [uploading, setUploading] = useState<Uploading[]>([])
  const [confirming, setConfirming] = useState<TaskAttachmentRecord | null>(null)
  const [error, setError] = useState<string | null>(null)

  const patch = (key: string, next: Partial<Uploading> | null) =>
    setUploading((rows) => next === null
      ? rows.filter((row) => row.key !== key)
      : rows.map((row) => (row.key === key ? { ...row, ...next } : row)))

  const upload = useCallback((files: File[]) => {
    for (const file of files) {
      const key = `${file.name}:${file.size}:${Math.random().toString(36).slice(2)}`
      const started = startUpload(file, {
        onProgress: ({ pct }) => patch(key, { pct }),
        taskId,
      })
      setUploading((rows) => [...rows, { abort: started.abort, filename: file.name, key, pct: 0 }])
      started.result
        .then(() => patch(key, null))
        .catch((cause: unknown) => {
          if (isUploadAborted(cause)) patch(key, null)
          else patch(key, { error: cause instanceof Error ? cause.message : 'Upload failed' })
        })
    }
  }, [startUpload, taskId])

  const drop = useFileDrop(upload, !canEdit)
  const attachments = attachmentsQuery.data ?? []

  const remove = (attachment: TaskAttachmentRecord) => {
    setError(null)
    removeAttachment.mutate(attachment.id, {
      onError: (cause) => setError(cause.message || `Could not remove ${attachment.filename}.`),
    })
  }

  const open = (attachment: TaskAttachmentRecord) => {
    const record = asAttachmentRecord(attachment)
    if (canViewAttachment(record)) openAttachment(record)
    else void downloadAuthedPath(attachment.downloadPath, attachment.filename, token).catch(() => undefined)
  }

  const who = (attachment: TaskAttachmentRecord) => {
    if (attachment.external) {
      return (
        <span className="flex items-center gap-1.5">
          <ProviderTile provider={attachment.external.provider} size={16} />
          From {PROVIDER_LABEL[attachment.external.provider]}
        </span>
      )
    }
    if (!attachment.uploaderUserId) return null
    const actor = resolveActor('user', attachment.uploaderUserId)
    return (
      <span className="flex items-center gap-1.5" title={`${actor.kind} ${actor.id}`}>
        <UserAvatar displayName={actor.name} size={16} token={token} userId={attachment.uploaderUserId} />
        {actor.name}
      </span>
    )
  }

  const row = (attachment: TaskAttachmentRecord) => {
    const external = attachment.external
    if (external && external.status !== 'stored') {
      const provider = PROVIDER_LABEL[external.provider]
      const failed = external.status === 'failed'
      return (
        <li className={rowClass} data-attachment-id={attachment.id} key={attachment.id}>
          <Thumbnail attachment={attachment} token={token} />
          <div className="grid min-w-0 flex-1">
            <span className="truncate text-sm text-[color:var(--tx)]" title={external.title ?? attachment.filename}>
              {failed ? `Couldn't copy from ${provider}` : external.title ?? attachment.filename}
            </span>
            <span className="truncate text-xs text-[color:var(--tx3)]">
              {failed ? external.title ?? attachment.filename : hostOf(external.externalUrl)}
            </span>
          </div>
          <a
            className="text-xs text-[color:var(--tx2)] underline hover:text-[color:var(--tx)]"
            href={external.externalUrl}
            rel="noopener noreferrer"
            target="_blank"
          >
            {failed ? `Open in ${provider} ↗` : 'Open ↗'}
          </a>
        </li>
      )
    }
    return (
      <li className={rowClass} data-attachment-id={attachment.id} key={attachment.id}>
        <button
          className="flex min-w-0 flex-1 items-center gap-3 text-left"
          onClick={() => open(attachment)}
          type="button"
        >
          <Thumbnail attachment={attachment} token={token} />
          <span className="grid min-w-0 flex-1">
            <span className="flex min-w-0 items-center gap-2">
              <span className="truncate text-sm text-[color:var(--tx)]" title={attachment.filename}>
                {attachment.filename}
              </span>
              {attachment.inline ? (
                <Pill size="sm" tone="muted" uppercase={false}>
                  {attachment.commentId ? 'in comment' : 'in description'}
                </Pill>
              ) : null}
            </span>
            <span className="flex flex-wrap items-center gap-x-2 text-xs text-[color:var(--tx3)]">
              <span>{formatBytes(Number(attachment.sizeBytes))}</span>
              {who(attachment)}
              <time dateTime={attachment.createdAt} title={exactTime(attachment.createdAt)}>
                {relativeTime(attachment.createdAt)}
              </time>
            </span>
          </span>
        </button>
        <button
          aria-label={`Download ${attachment.filename}`}
          className={iconButtonClass}
          onClick={() => void downloadAuthedPath(attachment.downloadPath, attachment.filename, token)
            .catch(() => setError(`Could not download ${attachment.filename}.`))}
          title="Download"
          type="button"
        >
          <FontAwesomeIcon icon={faDownload} />
        </button>
        {canEdit && !external ? (
          <button
            aria-label={`Remove ${attachment.filename}`}
            className={iconButtonClass}
            onClick={() => (attachment.inline ? setConfirming(attachment) : remove(attachment))}
            title="Remove"
            type="button"
          >
            <FontAwesomeIcon icon={faXmark} />
          </button>
        ) : null}
      </li>
    )
  }

  return (
    <section
      aria-label="Attachments"
      className="relative grid gap-2"
      data-testid="task-attachments"
      {...drop.dropHandlers}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <SectionLabel as="span" size="sm">
          Attachments{attachments.length > 0 ? ` · ${attachments.length}` : ''}
        </SectionLabel>
        {canEdit ? (
          <button
            className="admin-button admin-button-secondary admin-button-compact gap-1.5"
            onClick={() => fileInputRef.current?.click()}
            type="button"
          >
            <FontAwesomeIcon icon={faUpload} />
            Upload file
          </button>
        ) : null}
        <input
          aria-hidden="true"
          className="hidden"
          data-testid="task-attachments-input"
          multiple
          onChange={(event) => {
            const files = Array.from(event.target.files ?? [])
            event.target.value = ''
            if (files.length > 0) upload(files)
          }}
          ref={fileInputRef}
          tabIndex={-1}
          type="file"
        />
      </div>

      {attachmentsQuery.isLoading ? (
        <Skeleton count={2} variant="list" />
      ) : attachmentsQuery.isError ? (
        <Notice size="sm" tone="danger">
          Couldn't load attachments.{' '}
          <button className="underline" onClick={() => void attachmentsQuery.refetch()} type="button">
            Retry
          </button>
        </Notice>
      ) : attachments.length === 0 && uploading.length === 0 ? (
        <p className="py-1 text-sm text-[color:var(--tx3)]">
          {canEdit ? 'No files yet. Drop files here or upload.' : 'No files yet.'}
        </p>
      ) : (
        <ul className="grid gap-0.5">
          {uploading.map((entry) => (
            <li className={rowClass} data-uploading="true" key={entry.key}>
              <span className="flex h-10 w-10 flex-none items-center justify-center rounded-md bg-[color:var(--overlay-weak)] text-[color:var(--tx3)]">
                <FontAwesomeIcon icon={iconForFilename(entry.filename)} />
              </span>
              <span className="grid min-w-0 flex-1 gap-1">
                <span className="truncate text-sm text-[color:var(--tx)]">{entry.filename}</span>
                {entry.error ? (
                  <span className="text-xs text-[color:var(--danger-text)]">{entry.error}</span>
                ) : (
                  <span className="h-1 overflow-hidden rounded-full bg-[color:var(--overlay)]">
                    <span className="block h-full bg-[color:var(--accent)]" style={{ width: `${entry.pct}%` }} />
                  </span>
                )}
              </span>
              <button
                className="admin-button admin-button-secondary admin-button-compact"
                onClick={() => {
                  if (entry.error) patch(entry.key, null)
                  else entry.abort()
                }}
                type="button"
              >
                {entry.error ? 'Dismiss' : 'Cancel'}
              </button>
            </li>
          ))}
          {attachments.map(row)}
        </ul>
      )}

      {error ? <Notice role="alert" size="sm" tone="danger">{error}</Notice> : null}
      <DropZoneOverlay active={drop.isDragging} count={drop.draggingCount} label="Drop files to attach" />
      {attachmentViewer}
      <ConfirmDialog
        blocking
        body={`It is shown in ${confirming?.commentId ? 'a comment' : 'the description'}; the image will read “Image removed”.`}
        confirmLabel="Remove"
        destructive
        onCancel={() => setConfirming(null)}
        onConfirm={() => {
          const target = confirming
          setConfirming(null)
          if (target) remove(target)
        }}
        open={confirming !== null}
        title={confirming ? `Remove “${confirming.filename}”?` : 'Remove this file?'}
      />
    </section>
  )
}
