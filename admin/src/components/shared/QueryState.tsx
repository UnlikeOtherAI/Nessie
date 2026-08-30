import type { ReactNode } from 'react'

/**
 * The structural minimum a caller must hand over: whether the fetch is in
 * flight, whether it failed, and how to ask for it again. Every TanStack
 * `UseQueryResult` satisfies it; nothing else is read, so the component never
 * has to know the row type.
 *
 * A source with no `refetch` is deliberately *not* accepted. The one recovery
 * this component offers is a Retry wired to `refetch()`, and a Retry button
 * that cannot retry is worse than the sentence it replaces.
 */
type QueryStateSource = {
  isError: boolean
  isLoading: boolean
  refetch: () => unknown
}

type QueryStateProps = {
  /**
   * The body, deferred. It runs only in the success branch, so it may
   * dereference `query.data` without the `?? []` guard every inline triad
   * carried purely to survive the loading render.
   */
  children: () => ReactNode
  /**
   * Vertical rhythm only. The alignment, the text scale, the two tones and
   * the Retry affordance are not negotiable — those are what drifted. Padding
   * is not drift: `py-8` in a list column and `py-6` in a detail panel that
   * swaps with a `py-6` empty state are two correct answers to two questions,
   * and forcing one would misalign a state against the panel it replaces.
   */
  className?: string
  /**
   * Shown when `isEmpty` is true. Omit it when the success body already
   * renders its own "nothing here" — several list components do, and a page
   * that spells the empty line twice would show neither at the right size.
   */
  emptyLabel?: string
  /** The sentence before the Retry. Ends in a full stop; Retry follows it. */
  errorLabel: string
  isEmpty?: boolean
  loadingLabel: string
  query: QueryStateSource
}

/**
 * One loading line, one error block, one empty line.
 *
 * The triad was hand-spelled on every surface that fetches a list, and the
 * three states had drifted apart independently: the colour token was written
 * both `[var(--tx3)]` and `[color:var(--tx3)]` (identical CSS — tidiness, not
 * a bug), the ellipsis was sometimes three dots, and the *recovery* varied
 * most — an inline Retry here, "Please refresh." there, and on `/dashboards`
 * no error state at all, so a failed fetch rendered as an empty list.
 *
 * The recovery is the reason this is one component rather than a convention:
 * "the fetch failed" and "there is nothing here" are different facts with
 * different next moves, and a surface that cannot tell them apart lies to the
 * person reading it. Every state that goes through here offers the same way
 * out.
 *
 * **It is not a home for every state that happens to be a sentence.** A
 * surface whose loading state is a skeleton frame, whose error is a titled
 * block with a call to action, or whose empty state is a card with a button,
 * is answering a different question and keeps its own markup. Growing this
 * component to swallow those would make it a switch over its call sites.
 */
export const QueryState = ({
  children,
  className = 'py-8',
  emptyLabel,
  errorLabel,
  isEmpty = false,
  loadingLabel,
  query,
}: QueryStateProps) => {
  const line = (tone: string) => [className, 'text-center text-sm', tone].join(' ')

  if (query.isLoading) {
    return <div className={line('text-[color:var(--tx3)]')}>{loadingLabel}</div>
  }

  if (query.isError) {
    return (
      <div className={line('text-[color:var(--danger-text)]')}>
        {errorLabel}{' '}
        <button className="underline" onClick={() => void query.refetch()} type="button">
          Retry
        </button>
      </div>
    )
  }

  if (isEmpty && emptyLabel) {
    return <div className={line('text-[color:var(--tx3)]')}>{emptyLabel}</div>
  }

  return <>{children()}</>
}
