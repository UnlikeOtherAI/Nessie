import { Extension } from '@tiptap/core'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import type { Node as ProseMirrorNode } from '@tiptap/pm/model'

export type WikilinkTriggerState = {
  active: boolean
  from: number
  to: number
  query: string
}

export const INACTIVE_TRIGGER: WikilinkTriggerState = { active: false, from: 0, to: 0, query: '' }

// Matches an open, unterminated `[[query` right before the cursor within the
// current text block. The query excludes `[`, `]` and newlines so the trigger
// switches off as soon as the user types a closing bracket (the input rule in
// wikilink-node.ts takes over from there to finish a manually-typed `]]`).
const TRIGGER_RE = /\[\[([^[\]\n]{0,80})$/

const detectTrigger = (doc: ProseMirrorNode, pos: number): WikilinkTriggerState => {
  const $pos = doc.resolve(pos)
  const blockStart = $pos.start()
  const textBefore = doc.textBetween(blockStart, pos, '￼', '￼')
  const match = TRIGGER_RE.exec(textBefore)
  if (!match) return INACTIVE_TRIGGER
  const from = pos - match[0].length
  return { active: true, from, to: pos, query: match[1] ?? '' }
}

export const wikilinkSuggestionKey = new PluginKey<WikilinkTriggerState>('kbWikilinkSuggestion')

// Tracks whether the cursor currently sits just after an open `[[query` so a
// React-side popup (WikilinkSuggestionMenu) knows when to render and what to
// search for. Carries no decorations — the typed text is already visible —
// it only exposes plugin state for the popup to read via getState().
export const WikilinkSuggestion = Extension.create({
  name: 'kbWikilinkSuggestion',

  addProseMirrorPlugins() {
    return [
      new Plugin<WikilinkTriggerState>({
        key: wikilinkSuggestionKey,
        state: {
          init: (_config, { doc, selection }) => detectTrigger(doc, selection.from),
          apply(tr, current) {
            if (!tr.selection.empty) return INACTIVE_TRIGGER
            if (!tr.docChanged && !tr.selectionSet) return current
            return detectTrigger(tr.doc, tr.selection.from)
          },
        },
      }),
    ]
  },
})
