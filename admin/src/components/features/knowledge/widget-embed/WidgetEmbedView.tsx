import { NodeViewWrapper, ReactNodeViewRenderer } from '@tiptap/react'
import type { NodeViewProps } from '@tiptap/react'
import { EmbeddedWidget } from '../../dashboards/EmbeddedWidget'
import { WidgetEmbed } from './widget-embed-node'

/**
 * While EDITING, an embed is a compact chip.
 *
 * A live chart inside a text editor fights the cursor and re-renders under the
 * writer for no benefit — the author is arranging a document, not watching
 * data. The real widget appears in the read view.
 */
const EditorChip = ({ node, deleteNode }: NodeViewProps) => (
  <NodeViewWrapper
    className="my-2 flex items-center gap-2 rounded border px-2.5 py-2 text-xs"
    style={{ background: 'var(--overlay-weak)', borderColor: 'var(--sep)', color: 'var(--tx2)' }}
    data-testid="widget-embed-chip"
  >
    <span aria-hidden>📊</span>
    <span>Dashboard widget</span>
    <button
      className="ml-auto rounded px-1.5"
      onClick={() => deleteNode()}
      style={{ color: 'var(--tx3)' }}
      title="Remove"
      type="button"
    >
      ✕
    </button>
    <span className="sr-only">{String(node.attrs.embedId ?? '')}</span>
  </NodeViewWrapper>
)

/** While READING, the real widget. */
const ReaderWidget = ({ node }: NodeViewProps) => (
  <NodeViewWrapper className="my-3" data-testid="widget-embed-block">
    <EmbeddedWidget embedId={String(node.attrs.embedId ?? '')} surface="knowledge" />
  </NodeViewWrapper>
)

export const WidgetEmbedEditing = WidgetEmbed.extend({
  addNodeView() {
    return ReactNodeViewRenderer(EditorChip)
  },
})

export const WidgetEmbedReading = WidgetEmbed.extend({
  addNodeView() {
    return ReactNodeViewRenderer(ReaderWidget)
  },
})
