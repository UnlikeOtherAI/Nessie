import { useLayoutEffect, useRef, type ReactNode } from 'react'
import { runOverlayTransition } from '../../navigation/overlay'
import { useReducedMotion } from '../../navigation/reduced-motion'

/**
 * The ambient overlay kind (docs/navigation/overview.md §7): a toast, a call banner, a
 * ring — something that arrives beside the work rather than over it.
 *
 * A card is the one overlay that composes {@link runOverlayTransition} directly
 * instead of `useOverlay`, and the three things it does *not* do are the point:
 * it never owns Back (a notification is not a place you can go back from), it
 * never traps focus (it must not interrupt typing), and it keeps its
 * `role="status"` so a screen reader announces it without being moved to it.
 *
 * Motion is the shared card lane — a fade with the system's 4 px rise off the
 * edge it sits on, over `OVERLAY_MOTION.cardMs`, reduced motion at 0 ms through
 * the same path. Closing is animated too: `open` going false plays the card out
 * and *then* calls `onClosed`, which is what lets an owner keep the row in its
 * list until the motion has finished.
 */

export type CardRegion = 'top-right' | 'bottom'

type OverlayCardProps = {
  children: ReactNode
  className?: string
  /** Called once the close motion has played out; the owner removes the card then. */
  onClosed?: () => void
  open: boolean
}

export const OverlayCard = ({ children, className, onClosed, open }: OverlayCardProps) => {
  const elementRef = useRef<HTMLDivElement | null>(null)
  const reducedMotion = useReducedMotion()
  const onClosedRef = useRef(onClosed)
  onClosedRef.current = onClosed

  useLayoutEffect(() => {
    const element = elementRef.current
    if (!element) return undefined
    const run = runOverlayTransition({
      direction: open ? 'open' : 'close',
      element,
      kind: 'card',
      reducedMotion,
    })
    if (open) return () => run.cancel()
    let cancelled = false
    void run.finished.then(() => {
      if (!cancelled) onClosedRef.current?.()
    })
    return () => {
      cancelled = true
      run.cancel()
    }
  }, [open, reducedMotion])

  return (
    <div
      className={['overlay-card', className ?? ''].filter(Boolean).join(' ')}
      ref={elementRef}
      role="status"
    >
      {children}
    </div>
  )
}
