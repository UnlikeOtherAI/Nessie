import { collectStream, type FileService, type ProviderImage } from '@nessie/runtime'
import type { PrismaClient } from '@prisma/client'

/**
 * What an agent gets to know about the files hanging off the messages in its
 * context window.
 *
 * Two distinct things come out of here, and they are deliberately separate:
 *
 *  - an **inventory line** for every attachment, so a turn that is nothing but
 *    a photo is not an empty message and the model can name what it was sent
 *    (and reach for `attachment_read` on the ones it cannot look at);
 *  - **inlined image bytes** for the images a vision-capable model can actually
 *    look at, carried on the provider message rather than folded into its text.
 *
 * Bytes come through the one `FileService` chokepoint like every other blob
 * read. Nothing here throws: a missing object or an unreadable image costs the
 * run its picture, never the run.
 */

// Inlined directly. OpenAI-compatible and Codex vision endpoints take these four.
const INLINE_IMAGE_MIMES = new Set(['image/gif', 'image/jpeg', 'image/png', 'image/webp'])

// Above this an original is not worth base64-ing into every loop iteration —
// the stored 640px preview shows the model the same thing for a fraction of the
// bytes. HEIC/TIFF/SVG take the same route because no provider decodes them.
const MAX_INLINE_BYTES = 4 * 1024 * 1024

// A window's worth of pictures. Images are re-sent on every iteration of the
// agentic loop, so this is a standing cost for the whole run, not a one-off.
const MAX_IMAGES_PER_PROMPT = 6

export type MessageAttachment = {
  id: string
  filename: string
  kind: string
  mime: string
  sizeBytes: bigint
  thumbnailKey: string | null
}

const formatBytes = (bytes: bigint): string => {
  const kib = Number(bytes) / 1024
  return kib < 1024 ? `${Math.max(1, Math.round(kib))} KB` : `${(kib / 1024).toFixed(1)} MB`
}

/**
 * One line naming every file on a message, appended to that turn's text at
 * render time. Kept out of `Message.content` itself so it never changes what a
 * human wrote — or what the run compares its prompt against.
 */
export const describeAttachments = (attachments: MessageAttachment[]): string | null => {
  if (attachments.length === 0) {
    return null
  }
  const listed = attachments
    .map(
      (attachment) =>
        `${attachment.filename} (${attachment.mime}, ${formatBytes(attachment.sizeBytes)}, `
        + `id=${attachment.id})`,
    )
    .join('; ')
  return `[attached: ${listed}]`
}

export const loadMessageAttachments = async (
  prisma: PrismaClient,
  organizationId: string,
  messageIds: string[],
): Promise<Map<string, MessageAttachment[]>> => {
  const byMessage = new Map<string, MessageAttachment[]>()
  if (messageIds.length === 0) {
    return byMessage
  }

  const attachments = await prisma.attachment.findMany({
    where: { organizationId, messageId: { in: messageIds } },
    orderBy: { createdAt: 'asc' },
    select: {
      id: true,
      filename: true,
      kind: true,
      messageId: true,
      mime: true,
      sizeBytes: true,
      thumbnailKey: true,
    },
  })

  for (const attachment of attachments) {
    if (!attachment.messageId) {
      continue
    }
    const existing = byMessage.get(attachment.messageId)
    if (existing) {
      existing.push(attachment)
    } else {
      byMessage.set(attachment.messageId, [attachment])
    }
  }

  return byMessage
}

// Which bytes represent this attachment to a model: the original when a
// provider can decode it at a sane size, otherwise its stored preview. A file
// that is not an image at all has neither.
const inlineSourceFor = (
  attachment: MessageAttachment,
): 'original' | 'thumbnail' | null => {
  if (!attachment.mime.startsWith('image/')) {
    return null
  }
  if (INLINE_IMAGE_MIMES.has(attachment.mime) && attachment.sizeBytes <= BigInt(MAX_INLINE_BYTES)) {
    return 'original'
  }
  return attachment.thumbnailKey ? 'thumbnail' : null
}

const readImage = async (
  files: FileService,
  organizationId: string,
  attachment: MessageAttachment,
  source: 'original' | 'thumbnail',
): Promise<ProviderImage | null> => {
  try {
    const opened =
      source === 'original'
        ? await files.openStream(attachment.id, organizationId)
        : await files.openThumbnailStream(attachment.id, organizationId)
    if (!opened) {
      return null
    }
    const bytes = await collectStream(opened.stream)
    if (bytes.byteLength === 0) {
      return null
    }
    return { dataBase64: bytes.toString('base64'), mime: opened.attachment.mime }
  } catch {
    // A vanished object or an unreadable preview must never take the run down —
    // the turn still names the file, and the agent can say it could not see it.
    return null
  }
}

/**
 * Inline the images from a context window, newest message first so the most
 * recent picture always wins the budget when a thread has more than fits.
 *
 * `messageIds` is in conversation order; the returned map holds only the
 * messages that ended up with usable image bytes.
 */
export const loadInlineImages = async (
  files: FileService,
  organizationId: string,
  messageIds: string[],
  byMessage: Map<string, MessageAttachment[]>,
): Promise<Map<string, ProviderImage[]>> => {
  const images = new Map<string, ProviderImage[]>()
  let remaining = MAX_IMAGES_PER_PROMPT

  for (const messageId of [...messageIds].reverse()) {
    if (remaining === 0) {
      break
    }
    for (const attachment of byMessage.get(messageId) ?? []) {
      if (remaining === 0) {
        break
      }
      const source = inlineSourceFor(attachment)
      if (!source) {
        continue
      }
      const image = await readImage(files, organizationId, attachment, source)
      if (!image) {
        continue
      }
      const existing = images.get(messageId)
      if (existing) {
        existing.push(image)
      } else {
        images.set(messageId, [image])
      }
      remaining -= 1
    }
  }

  return images
}
