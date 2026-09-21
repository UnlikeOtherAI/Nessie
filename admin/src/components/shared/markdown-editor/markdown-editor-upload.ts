import type { Editor } from '@tiptap/core'
import type { Node as ProseMirrorNode } from '@tiptap/pm/model'
import { inlineAttachmentPath } from '@nessie/schemas'
import type { UploadProgress } from '../../../lib/upload-xhr'

/** The `MarkdownEditor`'s upload hook: bytes in, the stored attachment's id out. */
export type MarkdownImageUpload = (
  file: File,
  onProgress?: (progress: UploadProgress) => void,
) => Promise<{ id: string }>

/** The node that stands in for an image while its bytes are on their way. */
export const UPLOAD_PLACEHOLDER_NODE = 'imageUpload'

export type UploadEntry = { filename: string; pct: number }

/**
 * Progress for the placeholders on screen, outside the document: a percent
 * changing forty times a second is not an edit, and writing it into node
 * attributes would put every tick in the undo history.
 */
export type UploadProgressStore = {
  delete: (uploadId: string) => void
  get: (uploadId: string) => UploadEntry | undefined
  set: (uploadId: string, entry: UploadEntry) => void
  subscribe: (listener: () => void) => () => void
}

export const createUploadProgressStore = (): UploadProgressStore => {
  const entries = new Map<string, UploadEntry>()
  const listeners = new Set<() => void>()
  const notify = () => listeners.forEach((listener) => listener())
  return {
    delete: (uploadId) => {
      if (entries.delete(uploadId)) notify()
    },
    get: (uploadId) => entries.get(uploadId),
    set: (uploadId, entry) => {
      entries.set(uploadId, entry)
      notify()
    },
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}

/** Only images go inline; anything else pasted or dropped is left to the browser. */
export const imageFilesFrom = (files: FileList | readonly File[] | null | undefined): File[] =>
  Array.from(files ?? []).filter((file) => file.type.startsWith('image/'))

/** `screen shot.png` → `screen shot` — the alt text an inserted image starts with. */
export const imageAltFromFilename = (filename: string): string => {
  const dot = filename.lastIndexOf('.')
  return (dot > 0 ? filename.slice(0, dot) : filename).trim()
}

/**
 * `editor.getMarkdown()` without the blank lines a trailing empty paragraph
 * serialises to. StarterKit's trailing-node plugin appends that paragraph
 * after a list, a quote or a code block at the end of the document so the
 * caret can leave it; it is editing chrome, not content, and keeping it made
 * every save of such a description grow by `\n\n`.
 */
export const serializeEditorMarkdown = (editor: Pick<Editor, 'getMarkdown'>): string =>
  editor.getMarkdown().replace(/\n+$/, '')

const newUploadId = (): string =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`

const findPlaceholder = (doc: ProseMirrorNode, uploadId: string): { node: ProseMirrorNode; pos: number } | null => {
  let found: { node: ProseMirrorNode; pos: number } | null = null
  doc.descendants((node, pos) => {
    if (found) return false
    if (node.type.name === UPLOAD_PLACEHOLDER_NODE && node.attrs.uploadId === uploadId) {
      found = { node, pos }
      return false
    }
    return true
  })
  return found
}

const describeFailure = (error: unknown): string => {
  const raw = error instanceof Error ? error.message : String(error)
  if (/SECRET_INTERCEPTED/i.test(raw)) return 'it looks like it contains a secret'
  return raw || 'the upload failed'
}

export type UploadFailure = { filename: string; reason: string }

/**
 * Put a placeholder for each file at `pos` (the drop point, or the selection),
 * upload them, and swap each placeholder for its image as it lands. A failed
 * or cancelled upload removes its placeholder and is reported, never left in
 * the text.
 */
export const insertImageUploads = (
  editor: Editor,
  files: readonly File[],
  {
    onFailure,
    pos,
    store,
    upload,
  }: {
    onFailure: (failure: UploadFailure) => void
    pos?: number
    store: UploadProgressStore
    upload: MarkdownImageUpload
  },
): Promise<void>[] => {
  let at = pos ?? editor.state.selection.to
  return files.map((file) => {
    const uploadId = newUploadId()
    store.set(uploadId, { filename: file.name, pct: 0 })
    editor
      .chain()
      .insertContentAt(at, { type: UPLOAD_PLACEHOLDER_NODE, attrs: { filename: file.name, uploadId } })
      .run()
    // The next file goes after this one's placeholder.
    const placed = findPlaceholder(editor.state.doc, uploadId)
    if (placed) at = placed.pos + placed.node.nodeSize

    return upload(file, ({ pct }) => store.set(uploadId, { filename: file.name, pct }))
      .then(({ id }) => {
        const current = findPlaceholder(editor.state.doc, uploadId)
        // The person deleted the placeholder while it uploaded: the file is on
        // the ticket but not in the text, which is what they asked for.
        if (!current || editor.isDestroyed) return
        editor
          .chain()
          .insertContentAt(
            { from: current.pos, to: current.pos + current.node.nodeSize },
            { type: 'image', attrs: { alt: imageAltFromFilename(file.name), src: inlineAttachmentPath(id) } },
          )
          .run()
      })
      .catch((error: unknown) => {
        const current = editor.isDestroyed ? null : findPlaceholder(editor.state.doc, uploadId)
        if (current) {
          editor
            .chain()
            .deleteRange({ from: current.pos, to: current.pos + current.node.nodeSize })
            .run()
        }
        onFailure({ filename: file.name, reason: describeFailure(error) })
      })
      .finally(() => store.delete(uploadId))
  })
}
