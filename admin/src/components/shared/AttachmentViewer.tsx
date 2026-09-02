import { useCallback, useEffect, useState } from 'react'
import {
  attachmentPath,
  downloadAuthedPath,
  useAuthedObjectUrlFromPath,
  type AttachmentRecord,
} from '../../lib/uploads'
import { useOverlay } from '../overlays/useOverlay'

/**
 * Full-size view of one attachment: the ORIGINAL bytes, not the feed's
 * thumbnail. Opened by tapping a preview.
 *
 * Rendered by the feed rather than by the message row, because a modal inside a
 * row would inherit its ancestors' stacking and overflow contexts (there is no
 * portal anywhere in the admin). `useAttachmentViewer` is the seam — same shape
 * as `useThoughtProcessDialog`, which is how the reply panel gets this for free.
 */

// A blob: URL inherits the admin origin, so an uploaded text/html named "x.pdf"
// would execute in this session if its own content-type were trusted. The type
// is pinned instead.
const PDF_MIME = 'application/pdf'

const isViewableImage = (attachment: AttachmentRecord): boolean =>
  attachment.mime.startsWith('image/') && attachment.mime !== 'image/svg+xml'

const isViewablePdf = (attachment: AttachmentRecord): boolean => attachment.mime === PDF_MIME

/** True when opening this attachment full-size shows something meaningful. */
export const canViewAttachment = (attachment: AttachmentRecord): boolean =>
  isViewableImage(attachment) || isViewablePdf(attachment)

const AttachmentViewerDialog = ({
  attachment,
  onClose,
  token,
}: {
  attachment: AttachmentRecord
  onClose: () => void
  token: string | null
}) => {
  const close = useCallback(() => onClose(), [onClose])
  const overlay = useOverlay({
    id: 'attachment-viewer',
    kind: 'modal',
    label: `Close ${attachment.filename} preview`,
    onClose: close,
    open: true,
  })
  const [downloading, setDownloading] = useState(false)

  const pdf = isViewablePdf(attachment)
  const url = useAuthedObjectUrlFromPath(
    attachmentPath(attachment.id),
    token,
    pdf ? PDF_MIME : undefined,
  )

  // Nothing in the admin locks scroll, so the viewer does it itself: without
  // this the page behind keeps scrolling under the backdrop.
  useEffect(() => {
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = previous
    }
  }, [])

  const handleDownload = () => {
    setDownloading(true)
    void downloadAuthedPath(attachmentPath(attachment.id), attachment.filename, token)
      .catch(() => undefined)
      .finally(() => setDownloading(false))
  }

  return (
    // Not the shared `Dialog`: it locks page scroll behind the backdrop, which
    // the shell does not do. `useOverlay` still gives it the Back registration,
    // focus trap, drag-safe scrim and layer every other overlay gets
    // (docs/navigation.md §7).
    <div
      className={[
        'fixed inset-0 flex items-center justify-center p-4',
        'bg-[var(--scrim-strong)] backdrop-blur-sm',
      ].join(' ')}
      {...overlay.scrimProps}
      onKeyDown={(event) => {
        // Openable from inside the reply panel, which closes itself on a
        // window-level Escape. One keypress must not dismiss both.
        if (event.key === 'Escape') {
          event.stopPropagation()
        }
      }}
      style={overlay.layerStyle}
    >
      <div
        aria-labelledby="attachment-viewer-title"
        aria-modal="true"
        className={[
          'flex max-h-[calc(100vh-2rem)] w-full max-w-6xl flex-col overflow-hidden',
          'rounded-xl border border-[var(--sep)] bg-[var(--panel)] shadow-2xl',
        ].join(' ')}
        data-testid="attachment-viewer"
        ref={overlay.panelRef}
        role="dialog"
        tabIndex={-1}
      >
        <header className="flex flex-shrink-0 items-center justify-between gap-4 border-b border-[var(--sep)] px-5 py-3">
          <h2
            className="min-w-0 truncate text-sm font-semibold text-[var(--tx)]"
            id="attachment-viewer-title"
          >
            {attachment.filename}
          </h2>
          <div className="flex shrink-0 items-center gap-1">
            <button
              className="admin-button admin-button-secondary"
              disabled={downloading}
              onClick={handleDownload}
              type="button"
            >
              {downloading ? 'Downloading…' : 'Download'}
            </button>
            <button
              aria-label="Close preview"
              className={[
                'flex h-8 w-8 items-center justify-center rounded text-[var(--tx3)]',
                'hover:bg-[var(--overlay)] hover:text-[var(--tx)]',
              ].join(' ')}
              onClick={close}
              type="button"
            >
              ×
            </button>
          </div>
        </header>

        <div
          className="flex min-h-0 flex-1 items-center justify-center overflow-auto bg-[var(--scrim)] p-2"
          data-testid="attachment-viewer-body"
        >
          {!url ? (
            <p className="p-8 text-sm text-[color:var(--tx3)]">Loading…</p>
          ) : pdf ? (
            <iframe
              className="h-[calc(100vh-10rem)] w-full rounded border-0 bg-[var(--panel)]"
              src={url}
              title={attachment.filename}
            />
          ) : (
            <img
              alt={attachment.filename}
              className="max-h-[calc(100vh-9rem)] max-w-full object-contain"
              src={url}
            />
          )}
        </div>
      </div>
    </div>
  )
}

/**
 * Owns the viewer for a feed. Returns the opener to thread down to message
 * rows and the element to render once at the feed's own level.
 */
export const useAttachmentViewer = (token: string | null) => {
  const [attachment, setAttachment] = useState<AttachmentRecord | null>(null)
  const openAttachment = useCallback(
    (next: AttachmentRecord) => setAttachment(next),
    [],
  )

  return {
    openAttachment,
    attachmentViewer: attachment ? (
      <AttachmentViewerDialog
        attachment={attachment}
        token={token}
        onClose={() => setAttachment(null)}
      />
    ) : null,
  }
}
