import type { ReactNode } from 'react'

type EmptyStateProps = {
  /**
   * The one recovery this state offers, as a rendered control. It is a slot
   * rather than a `label`/`onClick` pair because the four surfaces that had
   * already grown an empty-state call to action spell it differently — a
   * `<Link>` on `/connections`, a secondary `<button>` on `/dashboards`, an
   * anchor on the knowledge filesystem root. The affordance is the caller's;
   * the frame around it is not.
   */
  action?: ReactNode
  children: ReactNode
  /**
   * Spacing and placement only — the dashed border, the fill and the text
   * scale are what make an empty state recognisable as one, and are not the
   * caller's to change. It exists because an empty state has to sit correctly
   * in whatever it replaces: full-bleed in a table's body, inset in a drawer,
   * centred in a panel.
   */
  className?: string
  /**
   * A bold line above the body. Optional because the majority of empty states
   * are a single sentence and a title would only restate them; supply one when
   * the body has to explain a next step rather than state a fact.
   */
  title?: ReactNode
}

/**
 * The admin's one "there is nothing here yet" card.
 *
 * The dashed border is what distinguishes it at a glance from a populated row,
 * which is the failure the plain-centred-text empty states had: on
 * `/settings/account?tab=notifications` an empty muted-channels list rendered as an
 * `admin-card p-3` line, visually identical to a list holding one channel.
 *
 * It answers "empty", never "loading" and never "failed" — those are
 * {@link QueryState}'s, and they carry a Retry this deliberately does not.
 * Several surfaces had stretched one empty sentence across all three facts;
 * a person cannot tell from "Could not load documents." rendered in an empty
 * frame whether to wait, retry, or create something.
 */
export const EmptyState = ({ action, children, className, title }: EmptyStateProps) => (
  <div
    className={[
      'rounded-xl border border-dashed border-[color:var(--sep)]',
      'bg-[color:var(--overlay-weak)] p-5 text-sm leading-6 text-[color:var(--tx3)]',
      className ?? '',
    ]
      .filter(Boolean)
      .join(' ')}
  >
    {title ? (
      <div className="font-semibold text-[color:var(--tx2)]">{title}</div>
    ) : null}
    <div className={title ? 'mt-1' : ''}>{children}</div>
    {action ? <div className="mt-3">{action}</div> : null}
  </div>
)
