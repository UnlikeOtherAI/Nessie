import { memo, useCallback, useMemo, type ReactNode } from 'react'
import {
  CURSOR_SENTINEL,
  locateCursorBlock,
  repairStreamingTail,
  splitMarkdownBlockSpans,
  withCursorMarker,
} from '../../../facades/threads/document-markdown'
import { MessageMarkdown } from './MessageMarkdown'

type StreamingMarkdownProps = {
  /** Where the agent is writing, as a UTF-16 offset into `markdown`. */
  cursor: number
  markdown: string
  /** The block holding the cursor, for when no marker could be placed. */
  onCursorBlock?: (node: HTMLElement | null) => void
  onCursorMarker?: (node: HTMLElement | null) => void
  // While true the tail block is repaired and re-parsed each commit; once the
  // document is complete the whole thing is rendered once, canonically.
  streaming: boolean
}

// A streamed document is model-authored and rendered in a popup nobody asked to
// open, so its links are never followed for the reader: no remote image is
// fetched (`allowRemoteImages={false}`) and mentions are not linkified —
// there is no channel context inside a document.
const identity = (text: string): ReactNode => text

/**
 * A block that will never change again: parsed once and memoized on its text,
 * so a document that has grown to a hundred blocks still costs one tail parse
 * per frame rather than a hundred.
 */
const FrozenBlock = memo(({ text }: { text: string }) => (
  <MessageMarkdown allowRemoteImages={false} renderInlineText={identity}>
    {text}
  </MessageMarkdown>
))
FrozenBlock.displayName = 'FrozenBlock'

/**
 * Renders markdown as it arrives.
 *
 * Mid-stream the document is split at top-level blank lines outside fenced
 * code: every block but the last and the one being edited is frozen. The tail
 * re-parses after `repairStreamingTail` closes whatever the model has not
 * finished typing, so a half-written code block reads as a code block instead
 * of six lines of prose.
 *
 * The block holding the cursor also carries an **invisible marker** at the
 * write position — a zero-width `WORD JOINER` spliced into a render-only copy
 * at a position that cannot change how the block parses (see
 * `cursorMarkerOffset`), turned into an empty `<span>` by the inline-text
 * renderer. It exists only so the viewport can find the cursor on screen; it
 * adds no glyph, no box and no line-break opportunity. Where no safe position
 * exists — inside fenced code, whose text is never re-rendered inline — no
 * marker is emitted and the caller falls back to the block element.
 *
 * Per-block parsing is knowingly an approximation (reference-style link
 * definitions and loose-list spacing are whole-document constructs), so when the
 * stream ends the view swaps to one canonical full-document render. Mid-stream
 * is honest; the final view is exact.
 */
export const StreamingMarkdown = ({
  cursor,
  markdown,
  onCursorBlock,
  onCursorMarker,
  streaming,
}: StreamingMarkdownProps) => {
  const spans = useMemo(
    () => (streaming ? splitMarkdownBlockSpans(markdown) : []),
    [markdown, streaming],
  )
  const location = useMemo(
    () => (streaming ? locateCursorBlock(spans, cursor) : null),
    [cursor, spans, streaming],
  )

  const renderWithMarker = useCallback(
    (text: string): ReactNode => {
      const at = text.indexOf(CURSOR_SENTINEL)
      if (at < 0) {
        return text
      }
      return (
        <>
          {text.slice(0, at)}
          <span className="doc-edit-cursor" ref={onCursorMarker} />
          {text.slice(at + CURSOR_SENTINEL.length)}
        </>
      )
    },
    [onCursorMarker],
  )

  if (!streaming) {
    return (
      <MessageMarkdown allowRemoteImages={false} renderInlineText={identity}>
        {markdown}
      </MessageMarkdown>
    )
  }

  return (
    <>
      {spans.map((span, index) => {
        const isTail = index === spans.length - 1
        const isCursor = location?.blockIndex === index
        const repaired = isTail ? repairStreamingTail(span.text) : span.text
        const text =
          isCursor && location ? withCursorMarker(repaired, location.localOffset) : repaired

        // Every block gets the same plain wrapper — they are block-level
        // elements already, so it changes no layout — and the one holding the
        // cursor hands its element to the follower, which measures it when no
        // marker could be placed inside.
        return (
          <div key={`block-${index}`} ref={isCursor ? onCursorBlock : undefined}>
            {!isTail && !isCursor ? (
              <FrozenBlock text={span.text} />
            ) : (
              <MessageMarkdown
                allowRemoteImages={false}
                renderInlineText={isCursor ? renderWithMarker : identity}
              >
                {text}
              </MessageMarkdown>
            )}
          </div>
        )
      })}
    </>
  )
}
