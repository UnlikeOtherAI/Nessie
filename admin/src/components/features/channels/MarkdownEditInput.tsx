import { useEffect, useRef } from 'react'
import {
  decorateMarkdownEditor,
  extractEditorText,
  setMarkdownEditorText,
} from '../../../lib/markdown-editor'

interface MarkdownEditInputProps {
  value: string
  onCancel: () => void
  onChange: (value: string) => void
  onSubmit: () => void
}

export const MarkdownEditInput = ({
  value,
  onCancel,
  onChange,
  onSubmit,
}: MarkdownEditInputProps) => {
  const editorRef = useRef<HTMLDivElement>(null)
  const composingRef = useRef(false)

  useEffect(() => {
    const editor = editorRef.current
    if (!editor || extractEditorText(editor) === value) return
    setMarkdownEditorText(editor, value)
    editor.focus()
  }, [value])

  return (
    <div
      ref={editorRef}
      aria-label="Edit message Markdown"
      className="admin-input admin-markdown-edit-input"
      contentEditable
      onCompositionEnd={(event) => {
        composingRef.current = false
        const text = extractEditorText(event.currentTarget)
        decorateMarkdownEditor(event.currentTarget, text)
        onChange(text)
      }}
      onCompositionStart={() => {
        composingRef.current = true
      }}
      onInput={(event) => {
        const editor = event.currentTarget
        const text = extractEditorText(editor)
        if (!composingRef.current) decorateMarkdownEditor(editor, text)
        onChange(text)
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter' && !event.shiftKey) {
          event.preventDefault()
          onSubmit()
        }
        if (event.key === 'Escape') onCancel()
      }}
      role="textbox"
      suppressContentEditableWarning
    />
  )
}
