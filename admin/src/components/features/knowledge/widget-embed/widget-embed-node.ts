import { Node, mergeAttributes } from '@tiptap/core'

/**
 * A dashboard widget embedded in a knowledge page.
 *
 * Built exactly like the wikilink node, for the same reason: the body stores a
 * REFERENCE and nothing else. `data-dashboard-embed-id` is the whole contract —
 * no widget data, no source URL, no config, no grant travels in the page HTML.
 * That is what stops an embed from becoming a way to launder access: the page
 * carries an id, and the server decides on every read whether this viewer may
 * resolve it.
 *
 * Atomic and block-level: a chart is not editable character-by-character, and
 * a cursor inside one would be misery for no benefit.
 */
export type WidgetEmbedAttrs = {
  embedId: string
}

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    kbWidgetEmbed: {
      insertWidgetEmbed: (attrs: WidgetEmbedAttrs) => ReturnType
    }
  }
}

export const WidgetEmbed = Node.create({
  name: 'kbWidgetEmbed',
  group: 'block',
  atom: true,
  selectable: true,
  draggable: true,

  addAttributes() {
    return {
      embedId: {
        default: '',
        parseHTML: (element) => element.getAttribute('data-dashboard-embed-id') ?? '',
        renderHTML: (attributes) =>
          attributes.embedId
            ? { 'data-dashboard-embed-id': attributes.embedId as string }
            : {},
      },
    }
  },

  parseHTML() {
    return [{ tag: 'div[data-dashboard-embed-id]' }]
  },

  renderHTML({ HTMLAttributes }) {
    // The server parses exactly this attribute back out of saved bodies to
    // maintain its placement index, so the round-trip must stay lossless.
    return ['div', mergeAttributes(HTMLAttributes)]
  },

  addCommands() {
    return {
      insertWidgetEmbed:
        (attrs) =>
          ({ commands }) =>
            commands.insertContent({ type: this.name, attrs }),
    }
  },
})
