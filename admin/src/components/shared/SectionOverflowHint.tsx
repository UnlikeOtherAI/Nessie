/**
 * "…and 12 more", closing a list that was deliberately capped.
 *
 * Promoted out of the project dashboard, where it was the one honest answer to
 * "this section shows the first few" — elsewhere the same situation produced a
 * plain-link "Show all N", a "Load more" button, and several lists that simply
 * stopped with no indication there was more.
 *
 * It is not pagination. A summary section that caps its rows says so with this
 * and points at the full list; a list that *is* the page pages with
 * `PaginationFooter`. Offering both on one surface is how a person ends up not
 * knowing which control governs what they are looking at.
 */

type SectionOverflowHintProps = {
  className?: string
  /** How many rows are not shown. Renders nothing at zero. */
  count: number
  /** The word for what is being counted, e.g. `'agent'`. Pluralised with `s`. */
  noun: string
  /** Opens the full list. Without one the hint is a plain, unclickable line. */
  onShowAll?: () => void
}

export const SectionOverflowHint = ({
  className,
  count,
  noun,
  onShowAll,
}: SectionOverflowHintProps) => {
  if (count <= 0) return null

  const text = `…and ${count} more ${noun}${count === 1 ? '' : 's'}`
  const classes = ['px-3 py-2 text-xs text-[color:var(--tx3)]', className ?? '']
    .filter(Boolean)
    .join(' ')

  if (!onShowAll) {
    return <div className={classes}>{text}</div>
  }

  return (
    <button
      className={[classes, 'text-left hover:text-[color:var(--tx2)]'].join(' ')}
      onClick={onShowAll}
      type="button"
    >
      {text}
    </button>
  )
}
