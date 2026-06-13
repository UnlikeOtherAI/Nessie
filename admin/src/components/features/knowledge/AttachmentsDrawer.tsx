import { useRef, useState } from 'react'
import { faDownload, faTrash, faXmark } from '@fortawesome/free-solid-svg-icons'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { useAuthSession } from '../../../providers/AuthSessionProvider'
import { downloadAuthedPath } from '../../../lib/uploads'
import { formatBytes, type UploadProgress } from '../../../lib/upload-xhr'
import {
  kbAttachmentDownloadPath,
  useDeleteAttachment,
  usePageAttachments,
  useUploadPageAttachment,
} from '../../../facades/knowledge/file-hooks'
import { DropZoneOverlay } from './DropZoneOverlay'
import { iconForMime } from './file-icons'
import { useFileDrop } from './useFileDrop'

// Right-hand attachments drawer. On desktop it docks as a right rail; on mobile
// (`open` over a full-screen sheet) it covers the page. Drag-and-drop, a button,
// and a native picker all upload an attachment to the page.
export const AttachmentsDrawer = ({
  pageId,
  open,
  onClose,
}: {
  pageId: string
  open: boolean
  onClose: () => void
}) => {
  const { token } = useAuthSession()
  const attachmentsQuery = usePageAttachments(open ? pageId : undefined)
  const upload = useUploadPageAttachment(pageId)
  const remove = useDeleteAttachment(pageId)
  const inputRef = useRef<HTMLInputElement>(null)
  const [progress, setProgress] = useState<UploadProgress | null>(null)

  const handleFile = (file: File) => {
    setProgress({ loaded: 0, total: file.size, pct: 0 })
    upload.mutate(
      { file, onProgress: setProgress },
      { onSettled: () => setProgress(null) },
    )
  }
  const { isDragging, dropHandlers } = useFileDrop(handleFile, upload.isPending)

  const attachments = attachmentsQuery.data ?? []

  return (
    <aside
      aria-hidden={!open}
      className={[
        'fixed right-0 top-0 z-40 flex h-full w-full flex-col border-l border-[color:var(--sep)]',
        'bg-[color:var(--main)] shadow-[-12px_0_40px_var(--scrim)] transition-transform duration-300 sm:w-[360px]',
        open ? 'translate-x-0' : 'translate-x-full',
      ].join(' ')}
    >
      <div className="flex h-[50px] flex-shrink-0 items-center gap-2 border-b border-[color:var(--sep)] px-4">
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
        {attachments.length === 0 ? (
          <p className="px-1 py-6 text-center text-sm text-[color:var(--tx3)]">
            No attachments yet. Drop a file here or use the button below.
          </p>
        ) : (
          <ul className="grid gap-1">
            {attachments.map((attachment) => (
              <li
                className="flex items-center gap-2 rounded-md px-2 py-2 hover:bg-[color:var(--overlay-weak)]"
                key={attachment.id}
              >
                <FontAwesomeIcon
                  className="h-4 w-4 flex-shrink-0 text-[color:var(--tx3)]"
                  fixedWidth
                  icon={iconForMime(attachment.mime)}
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm text-[color:var(--tx)]">
                    {attachment.filename}
                  </span>
                  <span className="block text-xs text-[color:var(--tx3)]">
                    {formatBytes(Number(attachment.sizeBytes))}
                  </span>
                </span>
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
                <button
                  aria-label={`Delete ${attachment.filename}`}
                  className="flex h-7 w-7 items-center justify-center rounded text-[color:var(--tx2)] hover:bg-[color:var(--overlay)] hover:text-[color:var(--danger)]"
                  disabled={remove.isPending}
                  onClick={() => remove.mutate(attachment.id)}
                  type="button"
                >
                  <FontAwesomeIcon className="h-3.5 w-3.5" icon={faTrash} />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="flex-shrink-0 border-t border-[color:var(--sep)] p-3">
        <button
          className="admin-button admin-button-primary w-full rounded-md px-3 py-2 text-xs"
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
      </div>
    </aside>
  )
}
