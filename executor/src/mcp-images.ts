import { createHash } from 'node:crypto'

import {
  EXECUTOR_IMAGE_MIME_TYPES,
  EXECUTOR_RESULT_IMAGE_MAXIMUM,
  EXECUTOR_RESULT_IMAGE_MAX_BYTES,
  EXECUTOR_RESULT_IMAGES_TOTAL_MAX_BYTES,
  ExecutorImageReferenceSchema,
  executorImageAttachmentMarker,
  executorImageUnavailableText,
  sniffExecutorImageMimeType,
  type ExecutorImageMimeType,
  type ExecutorImageReference,
} from '@nessie/schemas'

/**
 * Images leave an MCP result on the machine, before the result is measured.
 *
 * Every `image` content item with base64 `data` is decoded, checked, and
 * replaced by a reference `{type: 'image', mimeType, attachmentDigest,
 * byteLength}` naming bytes the daemon keeps beside the command and uploads
 * before the result's receipt (`command-attachments.ts`). The same base64
 * anywhere else in the result — Kelpie repeats its screenshot inside the text
 * item's JSON and in `structuredContent` — becomes a short marker, which is
 * what removes Kelpie's triplication without touching Kelpie. An image that is
 * not kept becomes a text placeholder saying why, and so do its copies.
 */

/** One image taken out of a result. */
export type ExecutorMcpImage = {
  bytes: Buffer
  /** `sha256:<hex>` over the decoded bytes. */
  digest: string
  mimeType: ExecutorImageMimeType
}

/**
 * Where a call's images go before its result is returned. The daemon's sink
 * writes them as the command's sidecars; a call with none cannot promise the
 * bytes exist, so its images become placeholders rather than references.
 */
export type ExecutorMcpImageSink = (images: readonly ExecutorMcpImage[]) => Promise<void>

// Copies elsewhere in the result are matched as exact substrings. A real image
// is never this short, and replacing every occurrence of a short string would
// rewrite program text that merely happens to contain it.
const MIN_COPY_LENGTH = 64

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/

const mebibytes = (bytes: number): string => `${bytes / 1024 / 1024} MiB`

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)

const decodedLength = (data: string): number =>
  Math.floor((data.length * 3) / 4) - (data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0)

/**
 * The image an item carries, or why it cannot be kept. Every reason is ours:
 * the one program-supplied value repeated, the declared type, has already
 * matched the allowlist.
 */
const readImage = (item: Record<string, unknown>): ExecutorMcpImage | string => {
  const { data } = item
  if (typeof data !== 'string' || !BASE64.test(data)) return 'the program sent no readable image data'
  const declared = typeof item.mimeType === 'string' ? item.mimeType.trim().toLowerCase() : ''
  if (!(EXECUTOR_IMAGE_MIME_TYPES as readonly string[]).includes(declared)) {
    return 'only PNG, JPEG, WebP and GIF images are delivered'
  }
  // Sized from its length first, so an oversized image is never decoded.
  if (decodedLength(data) > EXECUTOR_RESULT_IMAGE_MAX_BYTES) {
    return `larger than the ${mebibytes(EXECUTOR_RESULT_IMAGE_MAX_BYTES)} limit for one image`
  }
  const bytes = Buffer.from(data, 'base64')
  if (bytes.length === 0) return 'the program sent no readable image data'
  if (sniffExecutorImageMimeType(bytes) !== declared) return `its bytes are not the ${declared} it declares`
  return {
    bytes,
    digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
    mimeType: declared as ExecutorImageMimeType,
  }
}

const placeholder = (reason: string): Record<string, unknown> => ({
  text: executorImageUnavailableText(reason),
  type: 'text',
})

const referenceTo = (image: ExecutorMcpImage): ExecutorImageReference => ({
  type: 'image',
  mimeType: image.mimeType,
  attachmentDigest: image.digest,
  byteLength: image.bytes.length,
})

/** Every string in `value`, with each key of `copies` replaced by its value. */
const replaceCopies = (value: unknown, copies: ReadonlyMap<string, string>): unknown => {
  if (typeof value === 'string') {
    let text = value
    for (const [copy, replacement] of copies) {
      if (text.length >= copy.length && text.includes(copy)) text = text.split(copy).join(replacement)
    }
    return text
  }
  if (Array.isArray(value)) return value.map((entry) => replaceCopies(entry, copies))
  if (isRecord(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, replaceCopies(entry, copies)]))
  }
  return value
}

/**
 * The result with its images taken out, and the distinct images kept — at
 * most six, each at most 4 MiB, 8 MiB together. An image repeated in several
 * items is kept once and referenced from each.
 */
export const extractExecutorMcpImages = (
  result: Record<string, unknown>,
): { images: ExecutorMcpImage[]; result: Record<string, unknown> } => {
  if (!Array.isArray(result.content)) return { images: [], result }
  const kept = new Map<string, ExecutorMcpImage>()
  let keptBytes = 0
  const keep = (read: ExecutorMcpImage | string): ExecutorMcpImage | string => {
    if (typeof read === 'string' || kept.has(read.digest)) return read
    if (kept.size >= EXECUTOR_RESULT_IMAGE_MAXIMUM) {
      return `more than ${EXECUTOR_RESULT_IMAGE_MAXIMUM} images in one result`
    }
    if (keptBytes + read.bytes.length > EXECUTOR_RESULT_IMAGES_TOTAL_MAX_BYTES) {
      return `over the ${mebibytes(EXECUTOR_RESULT_IMAGES_TOTAL_MAX_BYTES)} limit for one result's images`
    }
    kept.set(read.digest, read)
    keptBytes += read.bytes.length
    return read
  }
  const copies = new Map<string, string>()
  const content = (result.content as unknown[]).map((entry) => {
    if (!isRecord(entry) || entry.type !== 'image') return entry
    const outcome = keep(readImage(entry))
    const { data } = entry
    if (typeof data === 'string' && data.length >= MIN_COPY_LENGTH && !copies.has(data)) {
      copies.set(data, typeof outcome === 'string'
        ? executorImageUnavailableText(outcome)
        : executorImageAttachmentMarker(outcome.digest))
    }
    return typeof outcome === 'string' ? placeholder(outcome) : referenceTo(outcome)
  })
  const document = { ...result, content }
  return {
    images: [...kept.values()],
    result: copies.size === 0 ? document : replaceCopies(document, copies) as Record<string, unknown>,
  }
}

/** The distinct image references a result carries, in order. */
export const executorMcpImageReferences = (result: Record<string, unknown>): ExecutorImageReference[] => {
  if (!Array.isArray(result.content)) return []
  const references = new Map<string, ExecutorImageReference>()
  for (const entry of result.content as unknown[]) {
    const parsed = ExecutorImageReferenceSchema.safeParse(entry)
    if (parsed.success && !references.has(parsed.data.attachmentDigest)) {
      references.set(parsed.data.attachmentDigest, parsed.data)
    }
  }
  return [...references.values()]
}

/**
 * The result with one image withdrawn: its references and its markers all
 * become the same placeholder, so nothing in the result names bytes that will
 * never be delivered.
 */
export const withdrawExecutorMcpImage = (
  result: Record<string, unknown>,
  digest: string,
  reason: string,
): Record<string, unknown> => {
  const text = executorImageUnavailableText(reason)
  const withdrawn = Array.isArray(result.content)
    ? {
      ...result,
      content: (result.content as unknown[]).map((entry) => (
        isRecord(entry) && entry.type === 'image' && entry.attachmentDigest === digest
          ? { text, type: 'text' }
          : entry
      )),
    }
    : result
  return replaceCopies(withdrawn, new Map([[executorImageAttachmentMarker(digest), text]])) as Record<string, unknown>
}

/**
 * The result a call answers with once its images are out of it and in the
 * sink's keeping. When they cannot be kept — no sink, or the sink failed —
 * each is withdrawn, so the result never references bytes nobody holds.
 */
export const settleExecutorMcpImages = async (
  result: Record<string, unknown>,
  sink: ExecutorMcpImageSink | undefined,
  log: (message: string, cause: unknown) => void,
): Promise<Record<string, unknown>> => {
  const extracted = extractExecutorMcpImages(result)
  if (extracted.images.length === 0) return extracted.result
  let reason = 'this machine has nowhere to keep images'
  if (sink) {
    try {
      await sink(extracted.images)
      return extracted.result
    } catch (error) {
      log('could not keep the images of an MCP result', error)
      reason = 'the image could not be kept on this machine'
    }
  }
  return extracted.images.reduce(
    (document, image) => withdrawExecutorMcpImage(document, image.digest, reason),
    extracted.result,
  )
}
