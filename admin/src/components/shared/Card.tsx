import { createContext, useContext, type ReactNode } from 'react'

/**
 * True anywhere inside a {@link Card}.
 *
 * The containers that can carry their own frame — {@link RowList},
 * {@link DataTable}, {@link KeyValueList} — read this and render frameless
 * when they are already inside one, so the no-nesting rule holds by
 * construction rather than by everyone remembering it.
 */
const CardContext = createContext(false)

export const useInsideCard = (): boolean => useContext(CardContext)

/**
 * `import.meta.env` is undefined under `node --test`, where the guard should
 * still fire; only a production bundle (`DEV === false`) opts out, because a
 * throw is a worse outcome for a person than a doubled border.
 */
const nestingChecksEnabled = import.meta.env?.DEV !== false

export type CardVariant = 'row' | 'section'

export type CardTone = 'attention' | 'default'

type CardProps = {
  as?: 'article' | 'div' | 'section'
  children: ReactNode
  /** Spacing and layout only. Border, radius and fill belong to the variant. */
  className?: string
  tone?: CardTone
  /**
   * `section` (16px) is a block of a page; `row` (12px) is one record in a
   * list of cards. They are the two densities the admin ships, and which one
   * applies is decided by what the card *is*, never by how much content it
   * happens to hold.
   */
  variant?: CardVariant
}

const variantClasses: Record<CardVariant, string> = {
  row: 'admin-card p-3',
  section: 'admin-card p-4',
}

/**
 * The admin's one card.
 *
 * **A card never contains a card.** Depth inside one is dividers and spacing,
 * not a second frame — the bordered box inside a bordered box was the single
 * most common reason two admin pages read as two different products. Nesting
 * throws in development so the mistake surfaces where it is written; in
 * production the inner card renders and the page is merely ugly.
 *
 * It is `.admin-card` and nothing else, deliberately. That class is unlayered
 * (see the long note above it in `styles.css`), so a Tailwind `border-*` or
 * `bg-*` utility on the same element is silently inert — which is why `tone`
 * is a prop resolved to a companion class rather than something a call site
 * can layer on. `ExecutorsPage` had three "needs attention" cards written as
 * `admin-card border-[color:var(--accent)]`; none of them ever rendered an
 * accent border.
 */
export const Card = ({
  as: Element = 'div',
  children,
  className,
  tone = 'default',
  variant = 'section',
}: CardProps) => {
  const insideCard = useInsideCard()

  if (nestingChecksEnabled && insideCard) {
    throw new Error(
      'Card cannot be nested inside another Card. Use dividers, spacing, or a '
      + 'RowList/KeyValueList/StatTile inside the outer card instead.',
    )
  }

  return (
    <CardContext.Provider value={true}>
      <Element
        className={[
          variantClasses[variant],
          tone === 'attention' ? 'admin-card-attention' : '',
          className ?? '',
        ]
          .filter(Boolean)
          .join(' ')}
      >
        {children}
      </Element>
    </CardContext.Provider>
  )
}
