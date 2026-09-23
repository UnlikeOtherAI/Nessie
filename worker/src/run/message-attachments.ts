import { collectStream, type FileService, type ProviderImage, type ProviderMessage } from '@nessie/runtime'
import type { PrismaClient } from '@prisma/client'

import {
  deriveProviderInputComponent,
  retainProviderInputComponent,
} from './execute/provenanced-provider-input.js'
import {
  EARLIER_TOOL_IMAGES_TEXT,
  isToolImagesMessage,
  readToolImageEntries,
  TOOL_IMAGE_TURNS_SHOWN,
  TOOL_IMAGES_INTRO,
  TOOL_IMAGES_NOT_SEEN_NOTE,
  type ToolImageEntry,
} from './tool-images.js'

/**
 * What an agent gets to know about the files hanging off the messages in its
 * context window, and the one place a prompt's image bytes come from.
 *
 * Two distinct things come out of here, and they are deliberately separate:
 *
 *  - an **inventory line** for every attachment, so a turn that is nothing but
 *    a photo is not an empty message and the model can name what it was sent
 *    (and reach for `attachment_read` on the ones it cannot look at);
 *  - **inlined image bytes** for the images a vision-capable model can actually
 *    look at, carried on the provider message rather than folded into its text.
 *
 * A message's own images are read when the run's prompt is built. The images a
 * tool returned are read later, each time a provider input is built
 * (`renderPromptImages`), because the transcript holds only their references;
 * that is also where the two share one budget.
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
// Messages' images and tools' images count against it together.
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

/** Where a run's tool images are read from, and whose they may be. */
export type ToolImageSource = {
  files: FileService
  organizationId: string
  prisma: PrismaClient
  /** Only an image one of this run's own executor commands returned is read. */
  runId: string
}

/**
 * Tool images this run has already read, by attachment id, so a picture is
 * not fetched again for every iteration. Each render keeps only the ones it
 * used, so it never holds more than one prompt's worth.
 */
export type ToolImageCache = Map<string, ProviderImage>

// The attachments behind these references, where each one is an image of one
// of this run's own executor commands. Anything else is not read.
const loadToolImageAttachments = async (
  source: ToolImageSource,
  attachmentIds: string[],
): Promise<Map<string, MessageAttachment>> => {
  const byId = new Map<string, MessageAttachment>()
  if (attachmentIds.length === 0) return byId
  try {
    const rows = await source.prisma.attachment.findMany({
      where: { executorCommandId: { not: null }, id: { in: attachmentIds }, organizationId: source.organizationId },
      select: {
        executorCommandId: true,
        filename: true,
        id: true,
        kind: true,
        mime: true,
        sizeBytes: true,
        thumbnailKey: true,
      },
    })
    const commandIds = [...new Set(rows.flatMap((row) => row.executorCommandId ?? []))]
    const commands = commandIds.length === 0 ? [] : await source.prisma.executorCommand.findMany({
      where: { id: { in: commandIds }, toolCall: { runId: source.runId } },
      select: { id: true },
    })
    const ours = new Set(commands.map((command) => command.id))
    for (const { executorCommandId, ...attachment } of rows) {
      if (executorCommandId && ours.has(executorCommandId)) byId.set(attachment.id, attachment)
    }
  } catch {
    // A failed lookup costs this call its pictures, and each line says so.
  }
  return byId
}

const readToolImage = async (
  source: ToolImageSource,
  attachment: MessageAttachment | undefined,
): Promise<ProviderImage | null> => {
  const from = attachment ? inlineSourceFor(attachment) : null
  return attachment && from ? readImage(source.files, source.organizationId, attachment, from) : null
}

const withImages = (
  { images: _images, ...message }: Extract<ProviderMessage, { role: 'user' }>,
  images: ProviderImage[],
): ProviderMessage => (images.length > 0 ? { ...message, images } : message)

/**
 * The conversation as one provider call sees it: every tool-images turn read
 * in from its references, and the prompt's six-image budget spent on the tool
 * images and the messages' own images together, newest first.
 *
 * Only the newest `TOOL_IMAGE_TURNS_SHOWN` tool-images turns carry pictures;
 * an older one says it is no longer shown. A model that cannot see images —
 * `supportsVision` is its connector's own answer — gets none at all, and each
 * image line says so and names the text alternative. The transcript is never
 * changed: the rule is applied again on every call, from references, so the
 * transcript's checkpoints hold no bytes and every call sees the same result
 * for the same turns.
 */
export const renderPromptImages = async (
  messages: ProviderMessage[],
  source: ToolImageSource,
  options: { cache?: ToolImageCache; supportsVision: boolean },
): Promise<ProviderMessage[]> => {
  const cache = options.cache ?? new Map<string, ProviderImage>()
  const toolTurns = messages.flatMap((message, index) => (isToolImagesMessage(message) ? [index] : []))
  const shown = new Set(options.supportsVision ? toolTurns.slice(-TOOL_IMAGE_TURNS_SHOWN) : [])
  const entriesAt = (index: number): ToolImageEntry[] => {
    const message = messages[index]!
    return isToolImagesMessage(message) ? readToolImageEntries(message) : []
  }
  const unread = [...shown].flatMap(entriesAt).map((entry) => entry.attachmentId).filter((id) => !cache.has(id))
  const attachments = await loadToolImageAttachments(source, [...new Set(unread)])
  const used = new Set<string>()
  let remaining = MAX_IMAGES_PER_PROMPT

  const renderToolTurn = async (index: number): Promise<ProviderMessage> => {
    const images: ProviderImage[] = []
    let lines: string[] = []
    if (!options.supportsVision) {
      lines = entriesAt(index).map((entry) => `${entry.line} ${TOOL_IMAGES_NOT_SEEN_NOTE}`)
    } else if (!shown.has(index)) {
      lines = [EARLIER_TOOL_IMAGES_TEXT]
    } else {
      for (const entry of entriesAt(index)) {
        if (remaining === 0) {
          lines.push(`${entry.line} (not shown: this prompt already carries ${MAX_IMAGES_PER_PROMPT} images)`)
          continue
        }
        const image = cache.get(entry.attachmentId)
          ?? await readToolImage(source, attachments.get(entry.attachmentId))
        if (!image) {
          lines.push(`${entry.line} (could not be loaded)`)
          continue
        }
        cache.set(entry.attachmentId, image)
        used.add(entry.attachmentId)
        images.push(image)
        remaining -= 1
        lines.push(entry.line)
      }
    }
    return {
      content: [TOOL_IMAGES_INTRO, ...lines].join('\n'),
      role: 'user',
      ...(images.length > 0 ? { images } : {}),
    }
  }

  const rendered = [...messages]
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!
    if (isToolImagesMessage(message)) {
      rendered[index] = deriveProviderInputComponent(message, await renderToolTurn(index), 'tool_images')
    } else if (message.role === 'user' && message.images?.length) {
      const kept = options.supportsVision ? message.images.slice(0, remaining) : []
      remaining -= kept.length
      if (kept.length < message.images.length) {
        rendered[index] = retainProviderInputComponent(message, withImages(message, kept))
      }
    }
  }
  for (const id of [...cache.keys()]) {
    if (!used.has(id)) cache.delete(id)
  }
  return rendered
}
