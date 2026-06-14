import { Extension } from '@tiptap/core'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import type { Node as ProseMirrorNode } from '@tiptap/pm/model'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import { relocateAnchor, type TextQuoteAnchor } from '@nessie/schemas'
import { buildDocText, offsetToPos } from './doc-text'

export type NoteAnchorInput = {
  id: string
  anchor: TextQuoteAnchor
  resolved: boolean
}

export const noteHighlightKey = new PluginKey<DecorationSet>('kbNoteHighlight')

const buildDecorations = (doc: ProseMirrorNode, notes: NoteAnchorInput[]): DecorationSet => {
  const docText = buildDocText(doc)
  const decorations: Decoration[] = []
  for (const note of notes) {
    const range = relocateAnchor(docText.text, note.anchor)
    if (!range) continue
    const from = offsetToPos(docText, range.start)
    const to = offsetToPos(docText, range.end)
    if (from == null || to == null || from >= to) continue
    decorations.push(
      Decoration.inline(from, to, {
        class: note.resolved ? 'kb-note-highlight kb-note-highlight-resolved' : 'kb-note-highlight',
        'data-note-id': note.id,
        // Make the highlight keyboard-focusable so the note card can be opened
        // without a mouse (the reader opens it on focus/Enter via RichTextContent).
        tabindex: '0',
        role: 'button',
        'aria-label': 'View note',
      }),
    )
  }
  return DecorationSet.create(doc, decorations)
}

// Read-only highlight layer: re-locates each note's text-quote anchor in the
// current document and paints an inline decoration carrying its note id (used by
// the reader to open the hover card). Notes are pushed in via a transaction meta
// so the set updates as annotations load/change without recreating the editor.
export const NoteHighlight = Extension.create<{ notes: NoteAnchorInput[] }>({
  name: 'kbNoteHighlight',

  addOptions() {
    return { notes: [] }
  },

  addProseMirrorPlugins() {
    const initialNotes = this.options.notes
    return [
      new Plugin<DecorationSet>({
        key: noteHighlightKey,
        state: {
          init: (_config, { doc }) => buildDecorations(doc, initialNotes),
          apply(tr, current) {
            const updated = tr.getMeta(noteHighlightKey) as NoteAnchorInput[] | undefined
            if (updated) return buildDecorations(tr.doc, updated)
            return tr.docChanged ? current.map(tr.mapping, tr.doc) : current
          },
        },
        props: {
          decorations(state) {
            return noteHighlightKey.getState(state)
          },
        },
      }),
    ]
  },
})
