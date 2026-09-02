import { NAV_MOTION, OVERLAY_MOTION } from './motion'

// The overlay family (docs/navigation/overview.md §7): four kinds plus the one
// sanctioned nesting, each with one stacking layer, one Back precedence and
// one motion. Every number here is mirrored as a token in styles.css
// (`--layer-*`); admin/test/navigation-overlay.test.ts pins the two equal.

export type OverlayKind = 'modal' | 'sheet' | 'popover' | 'card' | 'blocking'

// The layer scale. A card never covers a modal; a confirm over a modal (the
// one sanctioned nesting) sits in `blocking`; the navigation stack's own
// layers are `stack` and everything in-page stays below it.
export const OVERLAY_LAYER = Object.freeze({
  stack: 1,
  card: 40,
  popover: 50,
  sheet: 60,
  modal: 70,
  blocking: 80,
})

// Back precedence in the local-back registry: an open overlay outranks every
// nested stage (11–31) and column (20+), and the sanctioned nesting outranks
// the modal beneath it. A card never owns Back.
export const OVERLAY_BACK_PRIORITY = Object.freeze({
  popover: 70,
  sheet: 80,
  modal: 90,
  blocking: 100,
})

export type OverlayDirection = 'open' | 'close'

export type SheetSide = 'left' | 'right' | 'bottom'

export const overlayDurationMs = (kind: OverlayKind, reducedMotion: boolean): number => {
  if (reducedMotion) return 0
  switch (kind) {
    case 'modal':
    case 'blocking':
      return OVERLAY_MOTION.modalMs
    case 'popover':
      return OVERLAY_MOTION.popoverMs
    case 'sheet':
      return OVERLAY_MOTION.drawerMs
    case 'card':
      return OVERLAY_MOTION.cardMs
  }
}

type Keyframe = Record<string, string>

// A modal, a popover and a card fade with a 4 px rise, never a scale; a
// sheet slides from its edge; a card slides from the edge it lives on.
export const overlayKeyframes = (
  kind: OverlayKind,
  direction: OverlayDirection,
  side: SheetSide = 'right',
): [Keyframe, Keyframe] => {
  const hidden: Keyframe = kind === 'sheet'
    ? { transform: side === 'left' ? 'translate3d(-100%, 0, 0)' : side === 'right' ? 'translate3d(100%, 0, 0)' : 'translate3d(0, 100%, 0)' }
    : { opacity: '0', transform: 'translate3d(0, 4px, 0)' }
  const shown: Keyframe = kind === 'sheet'
    ? { transform: 'translate3d(0, 0, 0)' }
    : { opacity: '1', transform: 'translate3d(0, 0, 0)' }
  return direction === 'open' ? [hidden, shown] : [shown, hidden]
}

export type OverlayTransitionSpec = {
  element: Element | null
  kind: OverlayKind
  direction: OverlayDirection
  reducedMotion: boolean
  side?: SheetSide
}

export type OverlayTransitionRun = {
  durationMs: number
  finished: Promise<void>
  cancel: () => void
}

type Animatable = Element & {
  animate?: (keyframes: Keyframe[], options: KeyframeAnimationOptions) => Animation
}

// The one thing that moves an overlay: open and close on the Web Animations
// API on the kind's duration and the shared easing. Dismissal is never gated
// on it — state closes at once and the leaving element plays out inert.
export const runOverlayTransition = ({
  element,
  kind,
  direction,
  reducedMotion,
  side,
}: OverlayTransitionSpec): OverlayTransitionRun => {
  const durationMs = overlayDurationMs(kind, reducedMotion)
  const target = element as Animatable | null
  const animation = target && typeof target.animate === 'function'
    ? target.animate(overlayKeyframes(kind, direction, side), {
        duration: durationMs,
        easing: NAV_MOTION.easing,
        fill: 'both',
      })
    : null
  const finished = new Promise<void>((resolve) => {
    if (!animation) {
      resolve()
      return
    }
    animation.onfinish = () => resolve()
  })
  return { durationMs, finished, cancel: () => animation?.cancel() }
}
