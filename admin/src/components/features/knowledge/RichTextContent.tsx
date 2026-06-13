import { useEffect, type MouseEvent as ReactMouseEvent } from 'react'
import { EditorContent, useEditor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import { computeAnchor, type TextQuoteAnchor } from '@nessie/schemas'
import {
  NoteHighlight,
  noteHighlightKey,
  type NoteAnchorInput,
} from './notes/note-highlight-extension'

export type SelectionPoint = { top: number; left: number }

type RichTextContentProps = {
  html: string
  notes?: NoteAnchorInput[]
  onNoteHover?: (id: string) => void
  onSelectNote?: (anchor: TextQuoteAnchor, at: SelectionPoint) => void
}

// Read-only renderer for stored page HTML. Parsing through the ProseMirror
// schema drops scripts, event handlers and unknown tags, so stored HTML cannot
// execute — the content never reaches the DOM as a raw HTML string. When notes
// are supplied it also paints inline highlights and reports hover / new-selection
// so the reader can anchor comments to a passage.
export const RichTextContent = ({
  html,
  notes,
  onNoteHover,
  onSelectNote,
}: RichTextContentProps) => {
  const editor = useEditor({
    content: html,
    editable: false,
    editorProps: { attributes: { class: 'kb-prose' } },
    extensions: [
      StarterKit.configure({ link: { openOnClick: true } }),
      NoteHighlight.configure({ notes: notes ?? [] }),
    ],
    immediatelyRender: false,
  })

  useEffect(() => {
    if (editor && html !== editor.getHTML()) {
      editor.commands.setContent(html, { emitUpdate: false })
    }
  }, [editor, html])

  // Push note anchors into the highlight plugin whenever they change.
  useEffect(() => {
    if (!editor) return
    editor.view.dispatch(editor.state.tr.setMeta(noteHighlightKey, notes ?? []))
  }, [editor, notes])

  const handleMouseOver = onNoteHover
    ? (event: ReactMouseEvent) => {
        const target = (event.target as HTMLElement).closest('[data-note-id]')
        const id = target?.getAttribute('data-note-id')
        if (id) onNoteHover(id)
      }
    : undefined

  // Turn the current text selection into a text-quote anchor. Offsets are read
  // straight from the rendered DOM (container.textContent), the same text-node
  // projection the highlight layer relocates against — no ProseMirror posAtDOM,
  // which can throw for non-editable views and silently swallow the selection.
  const handleMouseUp =
    onSelectNote && editor
      ? () => {
          const selection = window.getSelection()
          if (!selection || selection.isCollapsed || selection.rangeCount === 0) return
          const quote = selection.toString()
          if (!quote.trim()) return
          const container = editor.view.dom as HTMLElement
          const range = selection.getRangeAt(0)
          if (!container.contains(range.commonAncestorContainer)) return
          const fullText = container.textContent ?? ''
          const pre = range.cloneRange()
          pre.selectNodeContents(container)
          pre.setEnd(range.startContainer, range.startOffset)
          const anchor = computeAnchor(fullText, quote, pre.toString().length)
          if (!anchor) return
          const rect = range.getBoundingClientRect()
          onSelectNote(anchor, { top: rect.bottom, left: rect.left + rect.width / 2 })
        }
      : undefined

  return (
    <div onMouseOver={handleMouseOver} onMouseUp={handleMouseUp}>
      <EditorContent editor={editor} />
    </div>
  )
}
