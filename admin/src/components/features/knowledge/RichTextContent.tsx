import { useEffect, type MouseEvent as ReactMouseEvent } from 'react'
import { EditorContent, useEditor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import { computeAnchor, type TextQuoteAnchor } from '@nessie/schemas'
import { buildDocText, posToOffset } from './notes/doc-text'
import {
  NoteHighlight,
  noteHighlightKey,
  type NoteAnchorInput,
} from './notes/note-highlight-extension'

type RichTextContentProps = {
  html: string
  notes?: NoteAnchorInput[]
  onNoteHover?: (id: string) => void
  onSelectNote?: (anchor: TextQuoteAnchor) => void
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

  // Turn the current text selection into a text-quote anchor, computed against
  // the same doc projection the highlight layer relocates against.
  const handleMouseUp =
    onSelectNote && editor
      ? () => {
          const selection = window.getSelection()
          if (!selection || selection.isCollapsed || selection.rangeCount === 0) return
          const quote = selection.toString()
          if (!quote.trim()) return
          const range = selection.getRangeAt(0)
          const { view } = editor
          let fromPos: number
          let toPos: number
          try {
            fromPos = view.posAtDOM(range.startContainer, range.startOffset)
            toPos = view.posAtDOM(range.endContainer, range.endOffset)
          } catch {
            return
          }
          const docText = buildDocText(view.state.doc)
          const startOffset = posToOffset(docText, Math.min(fromPos, toPos))
          if (startOffset == null) return
          const anchor = computeAnchor(docText.text, quote, startOffset)
          if (anchor) onSelectNote(anchor)
        }
      : undefined

  return (
    <div onMouseOver={handleMouseOver} onMouseUp={handleMouseUp}>
      <EditorContent editor={editor} />
    </div>
  )
}
