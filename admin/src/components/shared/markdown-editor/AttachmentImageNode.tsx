import { useSyncExternalStore } from 'react'
import { mergeAttributes, Node } from '@tiptap/core'
import Image from '@tiptap/extension-image'
import {
  NodeViewWrapper,
  ReactNodeViewRenderer,
  type ReactNodeViewProps,
} from '@tiptap/react'
import { AuthedAttachmentImage, isInlineAttachmentSrc } from '../AuthedAttachmentImage'
import {
  UPLOAD_PLACEHOLDER_NODE,
  type UploadProgressStore,
} from './markdown-editor-upload'

/**
 * The image as the editor shows it. An inline attachment (`/api/attachments/<id>`)
 * is fetched with the bearer token and shown from a `blob:` URL — the API path
 * never becomes an `<img src>`. Any other URL renders as a plain image, as it
 * would in chat.
 */
const AttachmentImageView = ({ node, selected }: ReactNodeViewProps) => {
  const src = typeof node.attrs.src === 'string' ? node.attrs.src : ''
  const alt = typeof node.attrs.alt === 'string' ? node.attrs.alt : undefined
  return (
    <NodeViewWrapper
      className="admin-markdown-editor-image"
      data-drag-handle=""
      data-selected={selected ? 'true' : undefined}
    >
      {isInlineAttachmentSrc(src)
        ? <AuthedAttachmentImage alt={alt} src={src} />
        : <img alt={alt ?? ''} src={src} />}
    </NodeViewWrapper>
  )
}

/**
 * `@tiptap/extension-image` with the authed node view. Its Markdown handlers
 * (`![alt](src)` both ways) are the package's own and are kept unchanged.
 */
export const AttachmentImage = Image.extend({
  addNodeView() {
    return ReactNodeViewRenderer(AttachmentImageView)
  },
})

type UploadPlaceholderOptions = { store: UploadProgressStore | null }

const UploadPlaceholderView = ({ extension, node }: ReactNodeViewProps) => {
  const store = (extension.options as UploadPlaceholderOptions).store
  const uploadId = String(node.attrs.uploadId ?? '')
  const entry = useSyncExternalStore(
    (listener) => store?.subscribe(listener) ?? (() => undefined),
    () => store?.get(uploadId),
    () => undefined,
  )
  const filename = entry?.filename ?? String(node.attrs.filename ?? 'image')
  const pct = entry?.pct ?? 0
  return (
    <NodeViewWrapper className="admin-markdown-editor-upload" contentEditable={false} data-uploading="true">
      <span className="admin-markdown-editor-upload-name">Uploading {filename}…</span>
      <span
        aria-label={`Uploading ${filename}`}
        aria-valuemax={100}
        aria-valuemin={0}
        aria-valuenow={pct}
        className="admin-markdown-editor-upload-track"
        role="progressbar"
      >
        <span className="admin-markdown-editor-upload-bar" style={{ width: `${pct}%` }} />
      </span>
    </NodeViewWrapper>
  )
}

/**
 * The block that holds an image's place while it uploads. It is never
 * content: it parses from nothing and serialises to nothing, so a draft saved
 * mid-upload carries no trace of it, and `insertImageUploads` replaces it with
 * the image (or removes it) when the upload settles.
 */
export const UploadPlaceholder = Node.create<UploadPlaceholderOptions>({
  name: UPLOAD_PLACEHOLDER_NODE,
  group: 'block',
  atom: true,
  selectable: false,
  draggable: false,

  addOptions() {
    return { store: null }
  },

  addAttributes() {
    return {
      filename: { default: '' },
      uploadId: { default: '' },
    }
  },

  parseHTML() {
    return []
  },

  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes(HTMLAttributes, { 'data-uploading': 'true' })]
  },

  renderMarkdown() {
    return ''
  },

  addNodeView() {
    return ReactNodeViewRenderer(UploadPlaceholderView)
  },
})
