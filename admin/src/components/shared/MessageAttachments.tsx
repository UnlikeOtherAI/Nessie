import { useEffect, useState } from 'react'
import {
  attachmentPath,
  attachmentThumbnailPath,
  attachmentUrl,
  useAuthedObjectUrlFromPath,
  type AttachmentRecord,
} from '../../lib/uploads'
import { useApiClient } from '../../providers/ApiClientProvider'
import { useAuthSession } from '../../providers/AuthSessionProvider'
import { canViewAttachment } from './AttachmentViewer'

const formatBytes = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

// Short label for a previewable non-image (today: PDF), so a rendered first
// page still reads as a document rather than as a picture of one.
const typeBadge = (attachment: AttachmentRecord): string | null =>
  attachment.mime === 'application/pdf' ? 'PDF' : null

/**
 * Inline preview of one attachment.
 *
 * The feed loads the THUMBNAIL, never the original — that is the whole point:
 * a 4 MB photo used to transfer 4 MB to paint a 320px box. The original is
 * fetched only when the reader opens the full-size viewer. Attachments stored
 * before thumbnails existed have none (there is no backfill), so an image
 * without one falls back to the original and everything else to a chip.
 */
const AttachmentPreview = ({
  attachment,
  onOpen,
  token,
}: {
  attachment: AttachmentRecord
  onOpen?: (attachment: AttachmentRecord) => void
  token: string | null
}) => {
  const isImage = attachment.kind === 'image'
  const path = attachment.hasThumbnail
    ? attachmentThumbnailPath(attachment.id)
    : isImage
      ? attachmentPath(attachment.id)
      : null
  const url = useAuthedObjectUrlFromPath(path, token)
  const badge = typeBadge(attachment)

  if (!url) {
    return <DownloadChip attachment={attachment} token={token} />
  }

  // Prefer the thumbnail's own geometry so the box is reserved at the size that
  // will actually be painted; fall back to the original's when there is none.
  const width = attachment.hasThumbnail ? attachment.thumbnailWidth : attachment.width
  const height = attachment.hasThumbnail ? attachment.thumbnailHeight : attachment.height
  const openable = Boolean(onOpen) && canViewAttachment(attachment)

  const image = (
    <img
      alt={attachment.filename}
      // h-auto/w-auto keep the intrinsic ratio: the column is a flex container,
      // whose default `align-items: stretch` would otherwise widen the image to
      // the message column while max-h-80 caps its height, squashing it.
      className={[
        'h-auto w-auto max-h-80 max-w-full self-start object-contain',
        'rounded-md border border-[color:var(--sep)]',
      ].join(' ')}
      decoding="async"
      // Intrinsic size reserves the right box before the bytes load, so the
      // feed does not jump.
      height={height}
      // Below-the-fold previews are not fetched until they approach the
      // viewport — a long channel no longer pays for its whole history.
      loading="lazy"
      src={url}
      width={width}
    />
  )

  const framed = badge ? (
    <span className="relative inline-flex self-start">
      {image}
      <span
        className={[
          'pointer-events-none absolute left-2 top-2 rounded px-1.5 py-0.5',
          'bg-[var(--scrim-strong)] text-[10px] font-semibold tracking-wide',
          'text-[color:var(--tx)]',
        ].join(' ')}
      >
        {badge}
      </span>
    </span>
  ) : (
    image
  )

  if (!openable) {
    return framed
  }
  return (
    <button
      aria-label={`View ${attachment.filename}`}
      className={[
        'inline-flex w-fit cursor-zoom-in self-start rounded-md',
        'transition-opacity hover:opacity-90',
      ].join(' ')}
      data-testid="attachment-preview-open"
      onClick={() => onOpen?.(attachment)}
      type="button"
    >
      {framed}
    </button>
  )
}

const DownloadChip = ({
  attachment,
  token,
}: {
  attachment: AttachmentRecord
  token: string | null
}) => {
  const [downloading, setDownloading] = useState(false)
  const handleDownload = () => {
    setDownloading(true)
    const headers = new Headers()
    if (token) headers.set('authorization', `Bearer ${token}`)
    // Raw fetch: the api client unwraps a JSON envelope, and a download needs
    // the response body as a blob to hand to an object URL.
    fetch(attachmentUrl(attachment.id), { headers })
      .then((res) => (res.ok ? res.blob() : Promise.reject(new Error(String(res.status)))))
      .then((blob) => {
        const objectUrl = URL.createObjectURL(blob)
        const link = document.createElement('a')
        link.href = objectUrl
        link.download = attachment.filename
        link.click()
        URL.revokeObjectURL(objectUrl)
      })
      .finally(() => setDownloading(false))
  }
  return (
    <button
      className={[
        'inline-flex items-center gap-2 rounded-md border',
        'border-[color:var(--sep)] bg-[color:var(--scrim)] px-3 py-2',
        'text-xs text-[color:var(--tx2)] hover:bg-[color:var(--overlay-weak)]',
      ].join(' ')}
      disabled={downloading}
      onClick={handleDownload}
      type="button"
    >
      <span className="font-semibold text-[color:var(--tx)]">{attachment.filename}</span>
      <span>{formatBytes(Number(attachment.sizeBytes))}</span>
      <span>{downloading ? '…' : '↓'}</span>
    </button>
  )
}

// Anything with a rendered preview shows it; everything else keeps the chip.
const hasPreview = (attachment: AttachmentRecord): boolean =>
  attachment.hasThumbnail === true || attachment.kind === 'image'

export const useMessageAttachments = (messageId: string | null): AttachmentRecord[] => {
  const apiClient = useApiClient()
  const [attachments, setAttachments] = useState<AttachmentRecord[]>([])

  useEffect(() => {
    let cancelled = false
    if (!messageId) {
      setAttachments([])
      return
    }
    apiClient
      .get<AttachmentRecord[]>(`/api/messages/${messageId}/attachments`)
      .then((records) => {
        if (!cancelled) setAttachments(records)
      })
      .catch(() => {
        if (!cancelled) setAttachments([])
      })
    return () => {
      cancelled = true
    }
  }, [apiClient, messageId])

  return attachments
}

export const MessageAttachments = ({
  attachments,
  onOpenAttachment,
  omitAttachmentId,
}: {
  attachments: AttachmentRecord[]
  onOpenAttachment?: (attachment: AttachmentRecord) => void
  /** Render this attachment at its owning surface instead of duplicating it here. */
  omitAttachmentId?: string | null
}) => {
  const { token } = useAuthSession()
  const visibleAttachments = attachments.filter((attachment) => attachment.id !== omitAttachmentId)

  if (visibleAttachments.length === 0) return null

  return (
    <div className="mt-2 flex flex-col gap-2">
      {visibleAttachments.map((attachment) =>
        hasPreview(attachment) ? (
          <AttachmentPreview
            attachment={attachment}
            key={attachment.id}
            token={token}
            onOpen={onOpenAttachment}
          />
        ) : (
          <DownloadChip attachment={attachment} key={attachment.id} token={token} />
        ),
      )}
    </div>
  )
}
