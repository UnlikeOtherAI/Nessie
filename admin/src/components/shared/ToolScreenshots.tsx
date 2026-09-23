import type { ToolCallAttachment } from '@nessie/schemas'

import {
  attachmentPath,
  attachmentThumbnailPath,
  useAuthedObjectUrlFromPath,
} from '../../lib/uploads'
import type { ViewableAttachment } from './AttachmentViewer'

/**
 * The images a tool call returned — a local program's screenshots — drawn
 * where a person reads the call: under its line in the thought-process dialog
 * and on its card in the agent page's tool execution log. One component for
 * both (AGENTS.md → Rule zero, "reuse the surface").
 *
 * A call carries refs, never bytes (`ToolCallEntry.attachments`); each image
 * here is fetched from the ordinary attachment routes — the thumbnail when
 * there is one, else the original — and a press opens the original in the
 * shared full-size viewer, which is the owner's to render.
 */

/** A screenshot as the shared viewer takes it. */
export const toViewableAttachment = (image: ToolCallAttachment): ViewableAttachment => ({
  filename: image.filename,
  id: image.attachmentId,
  mime: image.mimeType,
})

const ToolScreenshot = ({
  image,
  onOpen,
  token,
}: {
  image: ToolCallAttachment
  onOpen: (attachment: ViewableAttachment) => void
  token: string | null
}) => {
  const url = useAuthedObjectUrlFromPath(
    image.hasThumbnail ? attachmentThumbnailPath(image.attachmentId) : attachmentPath(image.attachmentId),
    token,
  )
  return (
    <button
      aria-label={`View ${image.filename}`}
      className={[
        'flex aspect-[5/3] w-full cursor-zoom-in items-center justify-center overflow-hidden',
        'rounded-md border border-[color:var(--sep)] bg-[var(--scrim)]',
        'transition-opacity hover:opacity-90',
      ].join(' ')}
      data-testid="tool-screenshot"
      onClick={() => onOpen(toViewableAttachment(image))}
      title={image.filename}
      type="button"
    >
      {url ? (
        // A browser screenshot is wide; its top is where the page starts, so
        // that is the part a fixed box keeps.
        <img
          alt=""
          className="h-full w-full object-cover object-top"
          decoding="async"
          loading="lazy"
          src={url}
        />
      ) : (
        <span className="text-[11px] text-[color:var(--tx3)]">Screenshot</span>
      )}
    </button>
  )
}

export const ToolScreenshots = ({
  attachments,
  className,
  onOpen,
  token,
}: {
  /** Absent from an API that predates the screenshots: nothing to draw. */
  attachments?: readonly ToolCallAttachment[]
  className?: string
  onOpen: (attachment: ViewableAttachment) => void
  token: string | null
}) => {
  if (!attachments || attachments.length === 0) return null
  return (
    <ul
      aria-label={attachments.length === 1 ? 'Screenshot' : `${attachments.length} screenshots`}
      className={['flex flex-wrap gap-2', className].filter(Boolean).join(' ')}
      data-testid="tool-screenshots"
    >
      {attachments.map((image) => (
        // 160 px wide, or half the row where that is narrower, so a phone
        // still shows two side by side.
        <li className="w-40 max-w-[calc(50%-0.25rem)]" key={image.attachmentId}>
          <ToolScreenshot image={image} onOpen={onOpen} token={token} />
        </li>
      ))}
    </ul>
  )
}
