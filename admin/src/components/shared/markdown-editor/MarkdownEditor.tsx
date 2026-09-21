import { useEffect, useMemo, useRef, useState } from 'react'
import type { AnyExtension } from '@tiptap/core'
import Placeholder from '@tiptap/extension-placeholder'
import { Markdown } from '@tiptap/markdown'
import { EditorContent, useEditor, type Editor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import { Notice } from '../../primitives/Notice'
import { AttachmentImage, UploadPlaceholder } from './AttachmentImageNode'
import { RichTextToolbar } from './RichTextToolbar'
import {
  createUploadProgressStore,
  imageFilesFrom,
  insertImageUploads,
  serializeEditorMarkdown,
  type MarkdownImageUpload,
  type UploadFailure,
  type UploadProgressStore,
} from './markdown-editor-upload'

export type { MarkdownImageUpload }

/** Heading levels a Markdown field offers; a field sits under its own label, so no H1. */
export const MARKDOWN_EDITOR_HEADING_LEVELS = [2, 3] as const

/**
 * The editor's schema and Markdown handling, in one place so the round-trip
 * test exercises exactly what a person types into.
 */
export const createMarkdownEditorExtensions = ({
  placeholder = '',
  store = null,
}: {
  placeholder?: string
  store?: UploadProgressStore | null
} = {}): AnyExtension[] => [
  StarterKit.configure({
    heading: { levels: [...MARKDOWN_EDITOR_HEADING_LEVELS] },
    link: { openOnClick: false, autolink: true },
  }),
  AttachmentImage,
  UploadPlaceholder.configure({ store }),
  Placeholder.configure({ placeholder }),
  Markdown,
]

export type MarkdownEditorProps = {
  /** The editable region's accessible name — `Description`, `Comment`. */
  ariaLabel: string
  autoFocus?: boolean
  className?: string
  /** Two lines at rest, growing with the text — the comment composer. */
  compact?: boolean
  disabled?: boolean
  onChange: (markdown: string) => void
  /** Cmd/Ctrl+Enter — post a comment, save an edit. */
  onSubmitShortcut?: () => void
  /**
   * Enables the Image button and image paste/drop. Receives each image file
   * and a progress callback; resolves with the stored attachment id, which is
   * written as `![alt](/api/attachments/<id>)`.
   */
  onUploadImage?: MarkdownImageUpload
  placeholder?: string
  /** Markdown. A change from outside re-seeds only when it differs from what the editor holds. */
  value: string
}

/**
 * The Markdown field: Tiptap in, Markdown out.
 *
 * The value is Markdown both ways (`@tiptap/markdown`), so what the person
 * formats is what the API stores and what `MessageMarkdown` renders back —
 * no HTML crosses the wire. Images are uploads: pasted, dropped or picked
 * files show a placeholder with progress, and become the inline-image form
 * when the bytes land.
 */
export const MarkdownEditor = ({
  ariaLabel,
  autoFocus = false,
  className,
  compact = false,
  disabled = false,
  onChange,
  onSubmitShortcut,
  onUploadImage,
  placeholder,
  value,
}: MarkdownEditorProps) => {
  const store = useMemo(() => createUploadProgressStore(), [])
  const [failures, setFailures] = useState<UploadFailure[]>([])

  // The editor is built once; its handlers read the latest props through refs.
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange
  const onUploadRef = useRef(onUploadImage)
  onUploadRef.current = onUploadImage
  const onSubmitRef = useRef(onSubmitShortcut)
  onSubmitRef.current = onSubmitShortcut
  // What this editor last said the value was, so the echo of its own
  // `onChange` coming back as `value` never re-seeds (and never moves the caret).
  const emittedRef = useRef<string>(value)
  const editorRef = useRef<Editor | null>(null)

  const startUploads = (files: File[], pos?: number) => {
    const editor = editorRef.current
    const upload = onUploadRef.current
    if (!editor || !upload || files.length === 0) return
    setFailures([])
    insertImageUploads(editor, files, {
      onFailure: (failure) => setFailures((current) => [...current, failure]),
      pos,
      store,
      upload,
    })
  }
  const startUploadsRef = useRef(startUploads)
  startUploadsRef.current = startUploads

  const editor = useEditor({
    autofocus: autoFocus ? 'end' : false,
    content: value,
    contentType: 'markdown',
    editable: !disabled,
    editorProps: {
      attributes: {
        'aria-label': ariaLabel,
        'aria-multiline': 'true',
        class: 'kb-prose admin-markdown-editor-prose',
        role: 'textbox',
      },
      handleDrop: (view, event, _slice, moved) => {
        if (moved || !onUploadRef.current) return false
        const files = imageFilesFrom(event.dataTransfer?.files)
        if (files.length === 0) return false
        event.preventDefault()
        const at = view.posAtCoords({ left: event.clientX, top: event.clientY })
        startUploadsRef.current(files, at?.pos)
        return true
      },
      handleKeyDown: (_view, event) => {
        if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && onSubmitRef.current) {
          event.preventDefault()
          onSubmitRef.current()
          return true
        }
        return false
      },
      handlePaste: (_view, event) => {
        if (!onUploadRef.current) return false
        const files = imageFilesFrom(event.clipboardData?.files)
        if (files.length === 0) return false
        event.preventDefault()
        startUploadsRef.current(files)
        return true
      },
    },
    extensions: createMarkdownEditorExtensions({ placeholder, store }),
    immediatelyRender: false,
    // The toolbar reads `isActive` on every render; it has to see each step.
    shouldRerenderOnTransaction: true,
    onUpdate: ({ editor: instance }) => {
      const markdown = serializeEditorMarkdown(instance)
      if (markdown === emittedRef.current) return
      emittedRef.current = markdown
      onChangeRef.current(markdown)
    },
  })
  editorRef.current = editor

  useEffect(() => {
    if (!editor || editor.isDestroyed) return
    if (value === emittedRef.current) return
    emittedRef.current = value
    if (value === serializeEditorMarkdown(editor)) return
    editor.commands.setContent(value, { contentType: 'markdown', emitUpdate: false })
  }, [editor, value])

  useEffect(() => {
    if (editor && !editor.isDestroyed) editor.setEditable(!disabled)
  }, [disabled, editor])

  return (
    <div
      className={['admin-markdown-editor', className].filter(Boolean).join(' ')}
      data-compact={compact ? 'true' : undefined}
      data-disabled={disabled ? 'true' : undefined}
    >
      {editor && !disabled ? (
        <RichTextToolbar
          className="admin-markdown-editor-toolbar"
          editor={editor}
          headingLevels={MARKDOWN_EDITOR_HEADING_LEVELS}
          linkShortcut
          onPickImages={onUploadImage ? (files) => startUploads(imageFilesFrom(files)) : undefined}
        />
      ) : null}
      <EditorContent className="admin-markdown-editor-content" editor={editor} />
      {failures.length > 0 ? (
        <Notice className="mt-2" role="alert" size="sm" tone="danger">
          {failures.map((failure) => (
            <span className="block" key={`${failure.filename}:${failure.reason}`}>
              Couldn’t add {failure.filename}: {failure.reason}
            </span>
          ))}
        </Notice>
      ) : null}
    </div>
  )
}
