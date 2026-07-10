import { mergeAttributes, Node, nodeInputRule } from '@tiptap/core'

// A wikilink is an atomic inline token — not editable character-by-character —
// that serializes to the backend's anchor contract: resolved links carry
// `data-kb-page-id`, unresolved ones carry `data-kb-unresolved-title`. The
// server parses exactly these two attributes out of saved page bodies to
// maintain its link index, so renderHTML must emit one or the other, never
// both, and parseHTML must round-trip them losslessly.
export type WikilinkAttrs = {
  pageId: string | null
  title: string
}

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    kbWikilink: {
      insertWikilink: (attrs: WikilinkAttrs) => ReturnType
    }
  }
}

// Matches text typed (or pasted) as `[[Some Title]]` and turns it into an
// unresolved wikilink node — the "manual close" path for users who type both
// brackets themselves instead of picking a suggestion.
const MANUAL_CLOSE_RE = /\[\[([^[\]\n]+)\]\]$/

export const Wikilink = Node.create({
  name: 'kbWikilink',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,

  addAttributes() {
    return {
      // Rendered manually in renderHTML (as one of two mutually exclusive
      // data attributes), so neither attribute auto-renders here.
      pageId: { default: null, renderHTML: () => ({}) },
      title: { default: '', renderHTML: () => ({}) },
    }
  },

  parseHTML() {
    return [
      {
        tag: 'a[data-kb-page-id]',
        getAttrs: (element) => ({
          pageId: (element as HTMLElement).getAttribute('data-kb-page-id'),
          title: (element as HTMLElement).textContent ?? '',
        }),
      },
      {
        tag: 'a[data-kb-unresolved-title]',
        getAttrs: (element) => {
          const el = element as HTMLElement
          return {
            pageId: null,
            title: el.getAttribute('data-kb-unresolved-title') ?? el.textContent ?? '',
          }
        },
      },
    ]
  },

  renderHTML({ node, HTMLAttributes }) {
    const title = node.attrs.title as string
    const pageId = node.attrs.pageId as string | null
    const linkAttrs = pageId ? { 'data-kb-page-id': pageId } : { 'data-kb-unresolved-title': title }
    return [
      'a',
      mergeAttributes(HTMLAttributes, linkAttrs, {
        class: pageId ? 'kb-wikilink' : 'kb-wikilink kb-wikilink-unresolved',
      }),
      title,
    ]
  },

  renderText({ node }) {
    return node.attrs.title as string
  },

  addCommands() {
    return {
      insertWikilink:
        (attrs: WikilinkAttrs) =>
        ({ commands }) =>
          commands.insertContent({ type: this.name, attrs }),
    }
  },

  addInputRules() {
    return [
      nodeInputRule({
        find: MANUAL_CLOSE_RE,
        type: this.type,
        getAttributes: (match) => ({ pageId: null, title: (match[1] ?? '').trim() }),
      }),
    ]
  },
})
