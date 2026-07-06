import { Fragment } from 'react'
import { splitPassageMatches } from '../../../lib/highlight-passage'

const markClass = 'rounded-[3px] bg-[color:var(--accent-soft)] px-0.5 text-[color:var(--tx)]'

type HighlightedPassageProps = {
  passage: string
  query: string
}

// Renders a knowledge-base passage with query-term matches emphasized via a
// theme-token background, mirroring how other result rows lean on
// `--accent-soft` for subtle emphasis rather than a hardcoded highlight color.
export const HighlightedPassage = ({ passage, query }: HighlightedPassageProps) => (
  <>
    {splitPassageMatches(passage, query).map((segment, index) =>
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
