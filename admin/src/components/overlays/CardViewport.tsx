import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useNavigationLayout } from '../../lib/mobile-shell'
import { OVERLAY_LAYER } from '../../navigation/overlay'
import { whenStackSettled } from '../../navigation/transition-state'
import { Card, type CardRegion } from './Card'

/**
 * The one region cards live in (docs/navigation/overview.md §7). Exactly one of these is
 * mounted per shell.
 *
 * Two things it owns that a card cannot decide for itself:
 *
 * - **Where the region is.** Top-right beside the work on `split`, above the
 *   tab bar on `single`. This used to be the toast viewport's own
 *   `max-width: 639.98px` media query — a breakpoint fork that disagreed with
 *   the shell's own layout decision the moment the two definitions drifted (a
 *   native iPad reports a wide viewport but is laid out as `single`; a narrow
 *   desktop window is not a phone). It reads `useNavigationLayout()` instead.
 * - **When a card is allowed to appear.** A card arriving mid-push would run a
 *   second motion across a screen that is already moving, so it waits on
 *   `whenStackSettled()` — resolved already when nothing is in flight, so the
 *   common case costs one microtask.
 */

export type CardItem = {
  children: ReactNode
  id: string
  // True while the card is playing out; its owner removes the row on `onLeft`.
  leaving?: boolean
}

type CardViewportProps = {
  cards: CardItem[]
  // Called once a leaving card's motion has finished.
  onLeft: (id: string) => void
}

export const cardRegionForLayout = (layout: 'single' | 'split'): CardRegion =>
  layout === 'single' ? 'bottom' : 'top-right'

export const CardViewport = ({ cards, onLeft }: CardViewportProps) => {
  const region = cardRegionForLayout(useNavigationLayout())
  const [settledIds, setSettledIds] = useState<string[]>([])
  const awaitedRef = useRef(new Set<string>())

  useEffect(() => {
    const live = new Set(cards.map((card) => card.id))
    for (const id of awaitedRef.current) {
      if (!live.has(id)) awaitedRef.current.delete(id)
    }
    setSettledIds((current) => {
      const next = current.filter((id) => live.has(id))
      return next.length === current.length ? current : next
    })
    for (const card of cards) {
      if (awaitedRef.current.has(card.id)) continue
      awaitedRef.current.add(card.id)
      const { id } = card
      void whenStackSettled().then(() => {
        setSettledIds((current) => (current.includes(id) ? current : [...current, id]))
      })
    }
  }, [cards])

  const visible = cards.filter((card) => settledIds.includes(card.id))
  if (visible.length === 0) return null

  return (
    <div
      aria-live="polite"
      aria-relevant="additions text"
      className="card-viewport"
      data-region={region}
      style={{ zIndex: `var(--layer-card, ${OVERLAY_LAYER.card})` }}
    >
      {visible.map((card) => (
        <Card key={card.id} onClosed={() => onLeft(card.id)} open={!card.leaving}>
          {card.children}
        </Card>
      ))}
    </div>
  )
}
