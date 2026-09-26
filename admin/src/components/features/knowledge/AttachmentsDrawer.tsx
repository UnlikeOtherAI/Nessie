import { useRef, useState } from 'react'
import {
  faDownload,
  faEye,
  faGrip,
  faList,
  faTrash,
  faXmark,
} from '@fortawesome/free-solid-svg-icons'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { useAuthSession } from '../../../providers/AuthSessionProvider'
import { attachmentThumbnailPath, downloadAuthedPath, useAuthedObjectUrlFromPath } from '../../../lib/uploads'
import { formatBytes, type UploadProgress } from '../../../lib/upload-xhr'
import {
  kbAttachmentDownloadPath,
  useDeleteAttachment,
  usePageAttachments,
  useUploadPageAttachment,
} from '../../../facades/knowledge/file-hooks'
import type { AttachmentRecord } from '../../../lib/uploads'
import { Sheet } from '../../overlays/Sheet'
import { ConfirmDialog } from '../../shared/ConfirmDialog'
import { DropZoneOverlay } from '../../shared/DropZoneOverlay'
import { QueryState } from '../../shared/QueryState'
import { Row, RowList } from '../../shared/RowList'
import { iconForMime } from '../../shared/file-icons'
import { firstFileOnly, useFileDrop } from '../../../hooks/useFileDrop'
import { canViewAttachment, useAttachmentViewer } from '../../shared/AttachmentViewer'
import { SectionLabel } from '../../primitives/SectionLabel'

// Right-hand attachments drawer: a 360 px sheet on a split layout, covering the
// page on a single-column one. Drag-and-drop, a button, and a native picker all
// upload an attachment to the page.
export const AttachmentsDrawer = ({
  canWrite,
  pageId,
  open,
  onClose,
  inline = false,
}: {
  canWrite: boolean
  pageId: string
  open: boolean
  onClose: () => void
  /** Keep the same attachment workflow in the document surface or as a sheet. */
  inline?: boolean
}) => {
  const { token } = useAuthSession()
  const attachmentsQuery = usePageAttachments(inline || open ? pageId : undefined)
  const upload = useUploadPageAttachment(pageId)
  const remove = useDeleteAttachment(pageId)
  const inputRef = useRef<HTMLInputElement>(null)
  const [progress, setProgress] = useState<UploadProgress | null>(null)
  const [pendingDelete, setPendingDelete] = useState<AttachmentRecord | null>(null)
  const [layout, setLayout] = useState<'grid' | 'list'>('grid')
  const { openAttachment, attachmentViewer } = useAttachmentViewer(token)

  const handleFile = (file: File) => {
    setProgress({ loaded: 0, total: file.size, pct: 0 })
    upload.mutate(
      { file, onProgress: setProgress },
      { onSettled: () => setProgress(null) },
    )
  }
  const { isDragging, dropHandlers } = useFileDrop(
    firstFileOnly(handleFile),
    upload.isPending || !canWrite,
  )

  const attachments = attachmentsQuery.data ?? []

  const attachmentList = inline ? (
    <QueryState
      className="py-6"
      emptyLabel={canWrite ? 'No attachments yet. Add one or drop a file here.' : 'No attachments yet.'}
      errorLabel="Couldn’t load attachments."
      isEmpty={attachments.length === 0}
      loadingLabel="Loading attachments…"
      query={attachmentsQuery}
    >
      {() => (
        <div className={layout === 'grid'
          ? 'grid grid-cols-[repeat(auto-fill,minmax(190px,1fr))] gap-3'
          : 'flex flex-col divide-y divide-[color:var(--sep)]'}>
          {attachments.map((attachment) => (
            <AttachmentCard
              attachment={attachment}
              key={attachment.id}
              layout={layout}
              onDelete={() => setPendingDelete(attachment)}
              onDownload={() => void downloadAuthedPath(
                kbAttachmentDownloadPath(attachment.id), attachment.filename, token,
              )}
              onPreview={() => openAttachment(attachment)}
              canDelete={canWrite}
              token={token}
            />
          ))}
        </div>
      )}
    </QueryState>
  ) : null

  return (
    inline ? (
      <section
        aria-labelledby="knowledge-attachments-title"
        className="relative mt-8 border-t border-[color:var(--sep)] pt-5"
        id="knowledge-page-attachments"
        tabIndex={-1}
        {...dropHandlers}
      >
        <DropZoneOverlay active={isDragging} progressPct={progress?.pct} uploading={upload.isPending} />
        <div className="mb-3 flex flex-wrap items-center gap-3">
          <SectionLabel as="h2" className="flex-1" id="knowledge-attachments-title" size="2xs">
            Attachments {attachments.length ? `(${attachments.length})` : ''}
          </SectionLabel>
          <div aria-label="Attachment layout" className="flex items-center gap-1" role="group">
            <button
              aria-label="List view"
              aria-pressed={layout === 'list'}
              className="flex h-8 w-8 items-center justify-center rounded text-[color:var(--tx2)] hover:bg-[color:var(--overlay)] aria-pressed:bg-[color:var(--accent-soft)]"
              onClick={() => setLayout('list')}
              type="button"
            ><FontAwesomeIcon className="h-4 w-4" icon={faList} /></button>
            <button
              aria-label="Grid view"
              aria-pressed={layout === 'grid'}
              className="flex h-8 w-8 items-center justify-center rounded text-[color:var(--tx2)] hover:bg-[color:var(--overlay)] aria-pressed:bg-[color:var(--accent-soft)]"
              onClick={() => setLayout('grid')}
              type="button"
            ><FontAwesomeIcon className="h-4 w-4" icon={faGrip} /></button>
          </div>
          {canWrite ? (
            <button
              className="admin-button admin-button-secondary admin-button-compact"
              disabled={upload.isPending}
              onClick={() => inputRef.current?.click()}
              type="button"
            >{upload.isPending ? `Uploading… ${progress?.pct ?? 0}%` : 'Add attachment'}</button>
          ) : null}
          {canWrite ? <input className="hidden" onChange={(event) => {
            const file = event.target.files?.[0]
            if (file) handleFile(file)
            event.target.value = ''
          }} ref={inputRef} type="file" /> : null}
        </div>
        {attachmentList}
        {attachmentViewer}
        <ConfirmDialog
          body={pendingDelete ? `“${pendingDelete.filename}” will be removed from this page.` : undefined}
          confirmLabel="Delete"
          destructive
          onCancel={() => setPendingDelete(null)}
          onConfirm={() => {
            if (!pendingDelete) return
            const attachment = pendingDelete
            setPendingDelete(null)
            remove.mutate(attachment.id)
          }}
          open={pendingDelete !== null}
          pending={remove.isPending}
          title="Delete attachment?"
        />
      </section>
    ) : <Sheet onClose={onClose} open={open} side="right" size="sm" title="Attachments">
      <div
        className={[
          'flex h-full w-full min-h-0 flex-col border-l border-[color:var(--sep)]',
          'bg-[color:var(--main)] shadow-[-12px_0_40px_var(--scrim)]',
        ].join(' ')}
      >
        <div className="flex h-[var(--page-header-height)] flex-shrink-0 items-center gap-2 border-b border-[color:var(--sep)] px-4">
          <h3 className="flex-1 text-sm font-semibold text-[color:var(--tx)]">
            Attachments {attachments.length ? `(${attachments.length})` : ''}
          </h3>
          <button
            aria-label="Close attachments"
            className="flex h-7 w-7 items-center justify-center rounded text-[color:var(--tx2)] hover:bg-[color:var(--overlay)]"
            onClick={onClose}
            type="button"
          >
            <FontAwesomeIcon className="h-4 w-4" icon={faXmark} />
          </button>
        </div>

        <div className="relative flex-1 overflow-y-auto p-3" {...dropHandlers}>
          <DropZoneOverlay
            active={isDragging}
            progressPct={progress?.pct}
            uploading={upload.isPending}
          />
          <QueryState
            className="py-6"
            emptyLabel={
              canWrite
                ? 'No attachments yet. Drop a file here or use the button below.'
                : 'No attachments yet.'
            }
            errorLabel="Couldn’t load attachments."
            isEmpty={attachments.length === 0}
            loadingLabel="Loading attachments…"
            query={attachmentsQuery}
          >
            {() => (
              <RowList>
                {attachments.map((attachment) => (
                  <Row
                    key={attachment.id}
                    leading={
                      <FontAwesomeIcon
                        className="h-4 w-4 text-[color:var(--tx3)]"
                        fixedWidth
                        icon={iconForMime(attachment.mime)}
                      />
                    }
                    subtitle={formatBytes(Number(attachment.sizeBytes))}
                    title={attachment.filename}
                    trailing={
                      <>
                        <button
                          aria-label={`Download ${attachment.filename}`}
                          className="flex h-7 w-7 items-center justify-center rounded text-[color:var(--tx2)] hover:bg-[color:var(--overlay)]"
                          onClick={() =>
                            void downloadAuthedPath(
                              kbAttachmentDownloadPath(attachment.id),
                              attachment.filename,
                              token,
                            )
                          }
                          type="button"
                        >
                          <FontAwesomeIcon className="h-3.5 w-3.5" icon={faDownload} />
                        </button>
                        {canWrite ? (
                          <button
                            aria-label={`Delete ${attachment.filename}`}
                            className="flex h-7 w-7 items-center justify-center rounded text-[color:var(--tx2)] hover:bg-[color:var(--overlay)] hover:text-[color:var(--danger-text)]"
                            onClick={() => setPendingDelete(attachment)}
                            type="button"
                          >
                            <FontAwesomeIcon className="h-3.5 w-3.5" icon={faTrash} />
                          </button>
                        ) : null}
                      </>
                    }
                  />
                ))}
              </RowList>
            )}
          </QueryState>
        </div>

        {canWrite ? <div className="flex-shrink-0 border-t border-[color:var(--sep)] p-3">
          <button
            className="admin-button admin-button-primary admin-button-compact w-full"
            disabled={upload.isPending}
            onClick={() => inputRef.current?.click()}
            type="button"
          >
            {upload.isPending ? `Uploading… ${progress?.pct ?? 0}%` : 'Add attachment'}
          </button>
          <input
            className="hidden"
            onChange={(event) => {
              const file = event.target.files?.[0]
              if (file) handleFile(file)
              event.target.value = ''
            }}
            ref={inputRef}
            type="file"
          />
        </div> : null}

        <ConfirmDialog
          body={pendingDelete ? `“${pendingDelete.filename}” will be removed from this page.` : undefined}
          confirmLabel="Delete"
          destructive
          onCancel={() => setPendingDelete(null)}
          onConfirm={() => {
            if (!pendingDelete) return
            const attachment = pendingDelete
            setPendingDelete(null)
            remove.mutate(attachment.id)
          }}
          open={pendingDelete !== null}
          pending={remove.isPending}
          title="Delete attachment?"
        />
      </div>
    </Sheet>
  )
}

const AttachmentCard = ({
  attachment,
  canDelete,
  layout,
  onDelete,
  onDownload,
  onPreview,
  token,
}: {
  attachment: AttachmentRecord
  canDelete: boolean
  layout: 'grid' | 'list'
  onDelete: () => void
  onDownload: () => void
  onPreview: () => void
  token: string | null
}) => {
  const thumbnail = useAuthedObjectUrlFromPath(
    attachment.hasThumbnail ? attachmentThumbnailPath(attachment.id) : null,
    token,
  )
  const hasPreview = canViewAttachment(attachment)
  const extension = /\.([^.]+)$/.exec(attachment.filename)?.[1]
  const type = attachment.mime === 'application/pdf'
    ? 'PDF'
    : extension?.toUpperCase() ?? attachment.mime.split('/')[0]?.toUpperCase() ?? 'FILE'
  return (
    <article className={layout === 'grid'
      ? 'min-w-0 overflow-hidden rounded-lg border border-[color:var(--sep)] bg-[color:var(--panel)]'
      : 'flex min-w-0 items-center gap-3 py-3 first:pt-0 last:pb-0'}>
      {layout === 'grid' ? (
        <button
          aria-label={hasPreview ? `View ${attachment.filename}` : attachment.filename}
          className="flex h-32 w-full items-center justify-center overflow-hidden bg-[color:var(--scrim)]"
          disabled={!hasPreview}
          onClick={onPreview}
          type="button"
        >
          {thumbnail ? <img alt="" className="h-full w-full object-contain" src={thumbnail} /> : (
            <FontAwesomeIcon className="h-8 w-8 text-[color:var(--tx3)]" fixedWidth icon={iconForMime(attachment.mime)} />
          )}
        </button>
      ) : hasPreview ? (
        <button aria-label={`View ${attachment.filename}`} className="h-14 w-14 shrink-0 overflow-hidden rounded bg-[color:var(--scrim)]" onClick={onPreview} type="button">
          <img alt="" className="h-full w-full object-cover" src={thumbnail ?? undefined} />
        </button>
      ) : (
        <FontAwesomeIcon className="h-5 w-5 shrink-0 text-[color:var(--tx3)]" fixedWidth icon={iconForMime(attachment.mime)} />
      )}
      <div className={layout === 'grid' ? 'min-w-0 px-3 py-2' : 'min-w-0 flex-1'}>
        <p className="truncate text-sm font-medium text-[color:var(--tx)]" title={attachment.filename}>{attachment.filename}</p>
        <p className="text-xs text-[color:var(--tx3)]">{type} · {formatBytes(Number(attachment.sizeBytes))}</p>
      </div>
      <div className={layout === 'grid' ? 'flex items-center justify-end gap-1 border-t border-[color:var(--sep)] px-2 py-1' : 'ml-auto flex items-center gap-1'}>
        {hasPreview && layout === 'list' ? (
          <button aria-label={`Preview ${attachment.filename}`} className="flex h-8 w-8 items-center justify-center rounded text-[color:var(--tx2)] hover:bg-[color:var(--overlay)]" onClick={onPreview} type="button"><FontAwesomeIcon className="h-3.5 w-3.5" icon={faEye} /></button>
        ) : null}
        <button aria-label={`Download ${attachment.filename}`} className="flex h-8 w-8 items-center justify-center rounded text-[color:var(--tx2)] hover:bg-[color:var(--overlay)]" onClick={onDownload} type="button"><FontAwesomeIcon className="h-3.5 w-3.5" icon={faDownload} /></button>
        {canDelete ? <button aria-label={`Delete ${attachment.filename}`} className="flex h-8 w-8 items-center justify-center rounded text-[color:var(--tx2)] hover:bg-[color:var(--overlay)] hover:text-[color:var(--danger-text)]" onClick={onDelete} type="button"><FontAwesomeIcon className="h-3.5 w-3.5" icon={faTrash} /></button> : null}
      </div>
    </article>
  )
}
