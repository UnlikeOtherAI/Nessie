// The one motion spec for navigation. Every push, every pop and every
// released edge swipe is driven by runStackTransition below, on the Web
// Animations API, from exactly the layers' current transform. There are no
// CSS keyframes for navigation: styles.css declares the static poses and
// mirrors these numbers as tokens (--nav-duration, --nav-easing,
// --nav-parallax); admin/test/navigation-motion.test.ts pins the two equal.
//
// Rulebook: docs/navigation.md §3.

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

export type StackDirection = 'forward' | 'back'

export type StackPoses = {
  top: { from: string; to: string }
  bottom: { from: string; to: string }
}

const percent = (value: number): string => `${(value * 100).toFixed(2)}%`

// `progress` is the top layer's displacement as a fraction of the viewport
// width: 0 = resting over the lower layer, 1 = fully off to the right. The
// lower layer sits at -parallax when the top layer rests and at 0 when the
// top layer is fully away, and travels in lockstep.
const topAt = (progress: number): string => `translate3d(${percent(progress)}, 0, 0)`
const bottomAt = (progress: number): string =>
  `translate3d(${percent(-(1 - progress) * NAV_MOTION.parallax)}, 0, 0)`

export const stackPoses = (direction: StackDirection, progress: number): StackPoses => {
  const target = direction === 'forward' ? 0 : 1
  return {
    top: { from: topAt(progress), to: topAt(target) },
    bottom: { from: bottomAt(progress), to: bottomAt(target) },
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
  from: string,
  to: string,
  durationMs: number,
): Animation | null => {
  const target = element as Animatable | null
  if (!target || typeof target.animate !== 'function') return null
  return target.animate([{ transform: from }, { transform: to }], {
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
  const topRun = animateLayer(top, poses.top.from, poses.top.to, durationMs)
  const bottomRun = animateLayer(bottom, poses.bottom.from, poses.bottom.to, durationMs)
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
    },
  }
}
