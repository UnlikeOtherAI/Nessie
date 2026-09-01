import type { ReactNode } from 'react'
import { useInsideCard } from './Card'

/**
 * A set of named facts about one record.
 *
 * Nine shapes of this were in the admin and none shared a line of code: two
 * bordered-`<dl>` variants, a boxed panel with stacked pairs, a two-column
 * grid, `FactRow` (byte-identical in two files), `PushStatusRow`, "Label:
 * value" prose, stacked `<div>`s, and a set of bordered tiles. Several used no
 * `<dl>` at all, so a screen reader heard a run of unrelated text where a
 * person saw pairs.
 *
 * It is always a real `<dl>`. Like {@link RowList}, the frame is automatic:
 * bordered standing alone, dividers only inside a {@link Card}.
 */

export type KeyValueItem = {
  /** Ids, keys, endpoints — anything a person may need to compare character by character. */
  mono?: boolean
  label: ReactNode
  value: ReactNode
}

export type KeyValueLayout = 'grid' | 'rows'

type KeyValueListProps = {
  className?: string
  items: KeyValueItem[]
  /**
   * `rows` — one pair per line, label left, value right. The default, and what
   * a detail pane wants.
   * `grid` — two columns of pairs, label above value. For eight or more short
   * facts, where `rows` would run down the page.
   */
  layout?: KeyValueLayout
}

const valueClass = 'min-w-0 text-sm text-[color:var(--tx)]'

const labelClass = 'text-xs text-[color:var(--tx3)]'

export const KeyValueList = ({ className, items, layout = 'rows' }: KeyValueListProps) => {
  const insideCard = useInsideCard()

  if (layout === 'grid') {
    return (
      <dl
        className={['grid gap-x-6 gap-y-3 sm:grid-cols-2', className ?? '']
          .filter(Boolean)
          .join(' ')}
      >
        {items.map((item, index) => (
          <div key={index}>
            <dt className={labelClass}>{item.label}</dt>
            <dd className={[valueClass, item.mono ? 'font-mono break-all' : ''].join(' ')}>
              {item.value}
            </dd>
          </div>
        ))}
      </dl>
    )
  }

  return (
    <dl
      className={[
        'divide-y divide-[color:var(--sep)]',
        insideCard
          ? ''
          : 'overflow-hidden rounded-xl border border-[color:var(--sep)] bg-[color:var(--panel)]',
        className ?? '',
      ]
        .filter(Boolean)
        .join(' ')}
    >
      {items.map((item, index) => (
        <div className="flex items-baseline justify-between gap-4 px-3 py-2.5" key={index}>
          <dt className={[labelClass, 'shrink-0'].join(' ')}>{item.label}</dt>
          <dd
            className={[valueClass, 'text-right', item.mono ? 'font-mono break-all' : '']
              .filter(Boolean)
              .join(' ')}
          >
            {item.value}
          </dd>
        </div>
      ))}
    </dl>
  )
}
