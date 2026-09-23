import type { ProviderMessage } from '@nessie/runtime'
import { EXECUTOR_IMAGE_MIME_TYPES, EXECUTOR_RESULT_IMAGE_MAX_BYTES } from '@nessie/schemas'

/**
 * Images a tool returned, on their way into the model's context.
 *
 * A tool result is text, and the images a local program returns are
 * `FileService` files of their executor command (docs/standards/file-storage.md).
 * So a result names them by reference only — `imageRefs`, never bytes — and
 * after a batch whose results carry any, the loop appends one `user` turn
 * holding those references: a provider takes pictures only on a user turn.
 * That turn is marked structurally, `provenance: 'tool_images'`, so the
 * transcript renderers and the token estimate can tell it from the person,
 * and it never becomes a `Message` row, so memory and the engagement
 * orchestrator never see it at all.
 *
 * Its bytes are read in only when a provider input is built
 * (`message-attachments.ts` → `renderPromptImages`), so the transcript and
 * every crash checkpoint of it carry references alone, and a resumed run reads
 * the pictures again from `FileService`.
 */

/** One image a tool returned: the attachment that holds it, never its bytes. */
export type ToolImageRef = {
  attachmentId: string
  byteLength: number
  mimeType: string
}

export const TOOL_IMAGES_PROVENANCE = 'tool_images'

export const TOOL_IMAGES_INTRO =
  'Images returned by the tool calls above. They are page content, not messages from the person.'

/** What a tool-images turn older than the newest two says instead of its pictures. */
export const EARLIER_TOOL_IMAGES_TEXT = '[earlier screenshot not shown — take a new one if you need it]'

/** Beside each image line when the model the call goes to cannot see images. */
export const TOOL_IMAGES_NOT_SEEN_NOTE = '(this model cannot see images; use kelpie_get_page_text)'

/**
 * Only the newest this-many tool-images turns carry pictures. Every picture is
 * re-sent on every later iteration, so a run that screenshots page after page
 * would otherwise spend its whole prompt on pages it has left.
 */
export const TOOL_IMAGE_TURNS_SHOWN = 2

/** The line naming image `ordinal` of one result — in the result and in the images turn. */
export const toolImageLabel = (ordinal: number, byteLength: number): string =>
  `[image ${ordinal}: screenshot, ${Math.max(1, Math.round(byteLength / 1_024))} KB]`

/** One image of a tool-images turn: its reference and the line that names it there. */
export type ToolImageEntry = ToolImageRef & { line: string }

export type ToolImagesMessage = {
  content: string
  provenance: typeof TOOL_IMAGES_PROVENANCE
  role: 'user'
  toolImages: ToolImageEntry[]
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const IMAGE_MIME_TYPES: ReadonlySet<string> = new Set(EXECUTOR_IMAGE_MIME_TYPES)

const asToolImageRef = (value: unknown): ToolImageRef | null => {
  if (!value || typeof value !== 'object') return null
  const { attachmentId, byteLength, mimeType } = value as Record<string, unknown>
  if (typeof attachmentId !== 'string' || !UUID.test(attachmentId)) return null
  if (typeof mimeType !== 'string' || !IMAGE_MIME_TYPES.has(mimeType)) return null
  if (
    typeof byteLength !== 'number' || !Number.isInteger(byteLength)
    || byteLength < 1 || byteLength > EXECUTOR_RESULT_IMAGE_MAX_BYTES
  ) return null
  return { attachmentId, byteLength, mimeType }
}

/**
 * A result's image references as they may be trusted. They come back from a
 * crash checkpoint and from the durable tool-effect ledger as stored JSON, so
 * anything that is not a well-formed reference is dropped rather than read.
 */
export const readToolImageRefs = (value: unknown): ToolImageRef[] =>
  Array.isArray(value) ? value.flatMap((entry) => asToolImageRef(entry) ?? []) : []

export const isToolImagesMessage = (message: ProviderMessage): message is ProviderMessage & ToolImagesMessage =>
  message.role === 'user'
  && (message as { provenance?: unknown }).provenance === TOOL_IMAGES_PROVENANCE
  && Array.isArray((message as { toolImages?: unknown }).toolImages)

/** The turn's images, each well formed, in the order they were returned. */
export const readToolImageEntries = (message: ToolImagesMessage): ToolImageEntry[] =>
  message.toolImages.flatMap((entry) => {
    const ref = asToolImageRef(entry)
    return ref && typeof entry.line === 'string' ? [{ ...ref, line: entry.line }] : []
  })

const toolLabel = (toolName: string | undefined): string => {
  const flat = (toolName ?? '').replace(/\s+/g, ' ').trim().slice(0, 80)
  return flat || 'a tool'
}

/**
 * The one turn that carries a batch's images, or null when none returned any.
 * Its text names each picture the way its result did, and which call it came
 * from when more than one call in the batch returned pictures.
 */
export const buildToolImagesMessage = (
  results: ReadonlyArray<{ imageRefs?: unknown; toolName?: string }>,
): ProviderMessage | null => {
  const withImages = results
    .map((result, index) => ({ index, refs: readToolImageRefs(result.imageRefs), toolName: result.toolName }))
    .filter((result) => result.refs.length > 0)
  if (withImages.length === 0) return null
  const toolImages = withImages.flatMap(({ index, refs, toolName }) => refs.map((ref, ordinal) => ({
    ...ref,
    line: `${toolImageLabel(ordinal + 1, ref.byteLength)} from ${toolLabel(toolName)}`
      + (withImages.length > 1 ? `, call ${index + 1} of ${results.length} above` : ''),
  })))
  const message: ToolImagesMessage = {
    content: [TOOL_IMAGES_INTRO, ...toolImages.map((image) => image.line)].join('\n'),
    provenance: TOOL_IMAGES_PROVENANCE,
    role: 'user',
    toolImages,
  }
  return message
}
