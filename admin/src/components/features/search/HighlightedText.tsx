import { Fragment } from 'react'
import { splitPassageMatches } from '../../../lib/highlight-passage'

const markClass = 'rounded-[3px] bg-[color:var(--accent-soft)] px-0.5 text-[color:var(--tx)]'

type HighlightedTextProps = {
  query: string
  text: string
}

/** Literal, case-insensitive query highlights shared by every result kind. */
export const HighlightedText = ({ query, text }: HighlightedTextProps) => (
  <>
    {splitPassageMatches(text, query).map((segment, index) =>
      segment.matched ? (
        <mark className={markClass} key={index}>
          {segment.text}
        </mark>
      ) : (
        <Fragment key={index}>{segment.text}</Fragment>
      ),
    )}
  </>
)
