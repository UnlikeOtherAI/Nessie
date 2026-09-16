// The one motion spec for navigation. Every push, every pop and every
// released edge swipe is driven by runStackTransition below, on the Web
// Animations API, from exactly the layers' current transform. There are no
// CSS keyframes for navigation: styles.css declares the static poses and
// mirrors these numbers as tokens (--nav-duration, --nav-easing,
// --nav-parallax); admin/test/navigation-motion.test.ts pins the two equal.
//
// Rulebook: docs/navigation/overview.md §3.

export const NAV_MOTION = Object.freeze({
  // A full-width push or pop.
  durationMs: 300,
  // A settle from a released swipe scales with the travel it still has to
  // cover, never below this — a release at 90% must not snap.
  minSettleMs: 120,
  // Decelerating, control points inside [0, 1]: it cannot overshoot.
  easing: 'cubic-bezier(0.22, 1, 0.36, 1)',
  // The revealed lower layer rests this fraction of the width to the left.
  parallax: 0.28,
})

export const OVERLAY_MOTION = Object.freeze({
  modalMs: 150,
  popoverMs: 120,
  drawerMs: 250,
  cardMs: 200,
})

// A screen that grows out of the thing that opened it — a dashboard tile on a
// project's Overview becoming that dashboard full screen. It is a third kind
// of motion beside the stack's slide and the overlay family's fade, and it
// lives here for the reason they do: one module owns navigation motion, so
// there is one place to change a curve and one place a test can pin.
//
// It does not move a screen: the route change is the framework's ordinary one,
// with its own registry row, its own Back and its own ledger entry. This only
// says how the arriving screen appears. On `single` the stack already slides
// the push, so the caller runs this on `split`, where nothing animated before.
export const ZOOM_MOTION = Object.freeze({
  durationMs: 260,
  // Matches the stack's curve: two kinds of navigation motion in one product
  // should decelerate the same way.
  easing: NAV_MOTION.easing,
})

/** A rectangle in viewport coordinates — what `getBoundingClientRect` gives. */
export type ExpandRect = {
  top: number
  left: number
  width: number
  height: number
}

/**
 * The transform that puts `to` exactly over `from`, so an element already in
 * its final place can be animated *from* the rectangle it grew out of.
 *
 * Scale is derived from width alone rather than per-axis: a tile and a page
 * rarely share an aspect ratio, and scaling the two axes differently stretches
 * the type inside for the length of the animation.
 */
export const expandFromPose = (from: ExpandRect, to: ExpandRect): string => {
  if (to.width <= 0 || to.height <= 0) return 'none'
  const scale = from.width / to.width
  const translateX = from.left + from.width / 2 - (to.left + to.width / 2)
  const translateY = from.top + from.height / 2 - (to.top + to.height / 2)
  return `translate3d(${translateX.toFixed(2)}px, ${translateY.toFixed(2)}px, 0) scale(${scale.toFixed(4)})`
}

export type ExpandTransitionSpec = {
  element: Element | null
  from: ExpandRect
  reducedMotion: boolean
}

/**
 * Grows `element` from `from` to wherever it already is. Returns the same
 * shape `runStackTransition` does, so a caller treats the two the same way.
 */
export const runExpandTransition = ({
  element,
  from,
  reducedMotion,
}: ExpandTransitionSpec): StackTransitionRun => {
  const durationMs = reducedMotion ? 0 : ZOOM_MOTION.durationMs
  const target = element as Animatable | null
  const to = target?.getBoundingClientRect?.()
  const run = durationMs > 0 && target && typeof target.animate === 'function' && to
    ? target.animate(
      [
        { opacity: '0.4', transform: expandFromPose(from, to) },
        { opacity: '1', transform: 'none' },
      ],
      { duration: durationMs, easing: ZOOM_MOTION.easing, fill: 'both' },
    )
    : null

  return {
    durationMs,
    finished: new Promise<void>((resolve) => {
      if (!run) {
        resolve()
        return
      }
      run.onfinish = () => resolve()
    }),
    cancel: () => run?.cancel(),
  }
}

export type StackDirection = 'forward' | 'back'

export type StackPoses = {
  top: { from: string; to: string }
  bottom: { from: string; to: string }
  // Opacity of the scrim over the lower layer: fully present while the top
  // layer rests over it, gone once the top layer is fully away.
  dim: { from: string; to: string }
}

const percent = (value: number): string => `${(value * 100).toFixed(2)}%`

// `progress` is the top layer's displacement as a fraction of the viewport
// width: 0 = resting over the lower layer, 1 = fully off to the right. The
// lower layer sits at -parallax when the top layer rests and at 0 when the
// top layer is fully away, and travels in lockstep.
const topAt = (progress: number): string => `translate3d(${percent(progress)}, 0, 0)`
const bottomAt = (progress: number): string =>
  `translate3d(${percent(-(1 - progress) * NAV_MOTION.parallax)}, 0, 0)`
// The revealed layer sits under a scrim that lifts as the top layer leaves,
// so the slide reads as a card coming off a dimmed page rather than two
// pages of equal weight crossing. The scrim's colour is the theme's
// --scrim; this is only how much of it shows.
export const dimAt = (progress: number): string => (1 - progress).toFixed(3)

// The scrim is the lower layer's own child, so the poses and the gesture
// address it through the layer rather than a second query in each caller.
export const DIM_SELECTOR = ':scope > [data-phone-navigation-dim]'

export const stackPoses = (direction: StackDirection, progress: number): StackPoses => {
  const target = direction === 'forward' ? 0 : 1
  return {
    top: { from: topAt(progress), to: topAt(target) },
    bottom: { from: bottomAt(progress), to: bottomAt(target) },
    dim: { from: dimAt(progress), to: dimAt(target) },
  }
}

// Remaining travel decides the duration, so a tap-driven push (progress 1,
// forward) takes the full duration and a swipe released near its end settles
// quickly — but never faster than minSettleMs. Reduced motion is 0 ms through
// the same path: the transition still runs, settles and commits.
export const stackDurationMs = (
  direction: StackDirection,
  progress: number,
  reducedMotion: boolean,
): number => {
  if (reducedMotion) return 0
  const remaining = direction === 'forward' ? progress : 1 - progress
  const scaled = NAV_MOTION.durationMs * Math.max(0, Math.min(1, remaining))
  return Math.min(NAV_MOTION.durationMs, Math.max(NAV_MOTION.minSettleMs, scaled))
}

export type StackTransitionSpec = {
  top: Element | null
  bottom: Element | null
  direction: StackDirection
  // Defaults to the full-travel start: 1 for a forward push, 0 for a pop.
  progress?: number
  reducedMotion: boolean
}

export type StackTransitionRun = {
  durationMs: number
  // Resolves when the top layer's animation finishes. Never rejects: a
  // cancelled run simply never resolves, and the caller's fallback timer
  // closes the lane.
  finished: Promise<void>
  cancel: () => void
}

type Animatable = Element & {
  animate?: (
    keyframes: Array<Record<string, string>>,
    options: KeyframeAnimationOptions,
  ) => Animation
}

const animateLayer = (
  element: Element | null,
  property: 'transform' | 'opacity',
  from: string,
  to: string,
  durationMs: number,
): Animation | null => {
  const target = element as Animatable | null
  if (!target || typeof target.animate !== 'function') return null
  return target.animate([{ [property]: from }, { [property]: to }], {
    duration: durationMs,
    easing: NAV_MOTION.easing,
    // Hold the end pose until the caller has committed the matching static
    // class and cancels the run; that ordering is what makes the hand-over
    // from animation to static pose invisible.
    fill: 'both',
  })
}

export const runStackTransition = ({
  top,
  bottom,
  direction,
  progress,
  reducedMotion,
}: StackTransitionSpec): StackTransitionRun => {
  const start = progress ?? (direction === 'forward' ? 1 : 0)
  const poses = stackPoses(direction, start)
  const durationMs = stackDurationMs(direction, start, reducedMotion)
  const topRun = animateLayer(top, 'transform', poses.top.from, poses.top.to, durationMs)
  const bottomRun = animateLayer(bottom, 'transform', poses.bottom.from, poses.bottom.to, durationMs)
  const dimRun = animateLayer(
    bottom?.querySelector(DIM_SELECTOR) ?? null,
    'opacity',
    poses.dim.from,
    poses.dim.to,
    durationMs,
  )
  const owner = topRun ?? bottomRun

  const finished = new Promise<void>((resolve) => {
    if (!owner) {
      // No Web Animations API (a test DOM, an old engine): the transition is
      // immediate, and the caller commits at once.
      resolve()
      return
    }
    owner.onfinish = () => resolve()
  })

  return {
    durationMs,
    finished,
    cancel: () => {
      topRun?.cancel()
      bottomRun?.cancel()
      dimRun?.cancel()
    },
  }
}
