import { useEffect, type FocusEvent as ReactFocusEvent, type MouseEvent as ReactMouseEvent } from 'react'
import { EditorContent, useEditor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import { computeAnchor, type TextQuoteAnchor } from '@nessie/schemas'
import {
  NoteHighlight,
  noteHighlightKey,
  type NoteAnchorInput,
} from './notes/note-highlight-extension'
import { WikilinkCreateConfirm } from './wikilink/WikilinkCreateConfirm'
import { useWikilinkNavigation } from './wikilink/use-wikilink-navigation'
import { Wikilink } from './wikilink/wikilink-node'

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
      Wikilink,
    ],
    immediatelyRender: false,
  })
  const { confirmCreate, navigateToPage, requestCreate, cancelCreate, confirmCreateNow } =
    useWikilinkNavigation()

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

  const openNoteFromEvent = (target: EventTarget | null) => {
    const id = (target as HTMLElement | null)?.closest('[data-note-id]')?.getAttribute('data-note-id')
    if (id) onNoteHover?.(id)
  }
  const handleMouseOver = onNoteHover
    ? (event: ReactMouseEvent) => openNoteFromEvent(event.target)
    : undefined
  // Keyboard parity: focusing a note highlight (tabindex on the decoration) opens
  // its card, so notes are readable without a mouse.
  const handleFocus = onNoteHover
    ? (event: ReactFocusEvent) => openNoteFromEvent(event.target)
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

  // Resolved wikilinks deep-link straight to their target page (after a
  // lazy pageId → spaceId lookup); unresolved ones open a small "create this
  // page?" confirmation instead of navigating anywhere.
  const handleClick = (event: ReactMouseEvent) => {
    const target = event.target as HTMLElement
    const resolvedEl = target.closest('[data-kb-page-id]')
    if (resolvedEl) {
      const pageId = resolvedEl.getAttribute('data-kb-page-id')
      if (pageId) navigateToPage(pageId)
      return
    }
    const unresolvedEl = target.closest('[data-kb-unresolved-title]')
    if (unresolvedEl) {
      const title = unresolvedEl.getAttribute('data-kb-unresolved-title')
      if (title) {
        const rect = unresolvedEl.getBoundingClientRect()
        requestCreate(title, { top: rect.bottom, left: rect.left + rect.width / 2 })
      }
    }
  }

  return (
    <div onClick={handleClick} onFocus={handleFocus} onMouseOver={handleMouseOver} onMouseUp={handleMouseUp}>
      <EditorContent editor={editor} />
      {confirmCreate ? (
        <WikilinkCreateConfirm
          at={confirmCreate.at}
          onCancel={cancelCreate}
          onConfirm={confirmCreateNow}
          title={confirmCreate.title}
        />
      ) : null}
    </div>
  )
}
