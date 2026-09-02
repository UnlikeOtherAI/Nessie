import type { ReactNode } from 'react'
import { SectionLabel } from '../primitives/SectionLabel'
import { useInsideCard } from './Card'

/**
 * One number a person is meant to read at a glance, with the label that says
 * what it counts.
 *
 * Four components and nine un-extracted copies of this shipped — `Stat`,
 * `CreditCard`, `SummaryCard`, and the inline tiles across the telemetry page
 * — at three value sizes (`text-2xl`, `text-xl`, unset), two weights and two
 * container radii, for the same "label / big value / small detail" job.
 *
 * `tone` colours the **value only**, never the tile: a red number reads as a
 * number that is bad, whereas a red box reads as an error in the page.
 */

export type StatTone = 'danger' | 'default' | 'success' | 'warning'

const toneClasses: Record<StatTone, string> = {
  danger: 'text-[color:var(--danger-text)]',
  default: 'text-[color:var(--tx)]',
  success: 'text-[color:var(--success-text)]',
  warning: 'text-[color:var(--warning-text)]',
}

type StatTileProps = {
  className?: string
  /** The sentence under the number: a comparison, a period, a unit. */
  detail?: ReactNode
  label: ReactNode
  tone?: StatTone
  value: ReactNode
}

export const StatTile = ({
  className,
  detail,
  label,
  tone = 'default',
  value,
}: StatTileProps) => {
  const insideCard = useInsideCard()

  return (
    <div
      className={[
        insideCard ? '' : 'admin-card p-4',
        className ?? '',
      ]
        .filter(Boolean)
        .join(' ')}
    >
      <SectionLabel size="sm">{label}</SectionLabel>
      <div className={['mt-2 text-2xl font-semibold', toneClasses[tone]].join(' ')}>{value}</div>
      {detail ? (
        <div className="mt-1 text-xs text-[color:var(--tx3)]">{detail}</div>
      ) : null}
    </div>
  )
}

type StatGridProps = {
  children: ReactNode
  className?: string
}

/**
 * The row stat tiles sit in. Tiles are laid out **beside** each other, never
 * stacked inside a surrounding card — that arrangement is what produced the
 * nested boxes on the billing and integrations pages.
 */
export const StatGrid = ({ children, className }: StatGridProps) => (
  <div
    className={['grid gap-4 sm:grid-cols-2 lg:grid-cols-3', className ?? '']
      .filter(Boolean)
      .join(' ')}
  >
    {children}
  </div>
)
