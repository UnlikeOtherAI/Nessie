import { memo, useMemo, type ReactNode } from 'react'
import {
  repairStreamingTail,
  splitMarkdownBlocks,
} from '../../../facades/threads/document-stream-helpers'
import { MessageMarkdown } from './MessageMarkdown'

type StreamingMarkdownProps = {
  markdown: string
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
 * code: every block but the last is frozen, and only the tail re-parses — after
 * `repairStreamingTail` closes whatever the model has not finished typing, so a
 * half-written code block reads as a code block instead of six lines of prose.
 *
 * Per-block parsing is knowingly an approximation (reference-style link
 * definitions and loose-list spacing are whole-document constructs), so when the
 * stream ends the view swaps to one canonical full-document render. Mid-stream
 * is honest; the final view is exact.
 */
export const StreamingMarkdown = ({ markdown, streaming }: StreamingMarkdownProps) => {
  const blocks = useMemo(
    () => (streaming ? splitMarkdownBlocks(markdown) : []),
    [markdown, streaming],
  )

  if (!streaming) {
    return (
      <MessageMarkdown allowRemoteImages={false} renderInlineText={identity}>
        {markdown}
      </MessageMarkdown>
    )
  }

  const tail = blocks.length > 0 ? blocks[blocks.length - 1] : null

  return (
    <>
      {blocks.slice(0, -1).map((text, index) => (
        <FrozenBlock key={`block-${index}`} text={text} />
      ))}
      {tail === null ? null : (
        <MessageMarkdown allowRemoteImages={false} renderInlineText={identity}>
          {repairStreamingTail(tail)}
        </MessageMarkdown>
      )}
    </>
  )
}
