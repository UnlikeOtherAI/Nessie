// Pure decision logic for the phone's interactive back-swipe. The viewport
// owns the DOM and routing side effects; this module decides what a finger
// does at each moment so the behaviour can be tested without a browser.

export const PHONE_BACK_SWIPE_EDGE_PX = 28
export const PHONE_BACK_SWIPE_COMMIT_RATIO = 0.42
export const PHONE_BACK_SWIPE_FLICK_MIN_PROGRESS = 0.08
export const PHONE_BACK_SWIPE_COMMIT_VELOCITY_PX_PER_MS = 0.5
// Settle timing and the underlay's parallax travel are the navigation motion
// spec's (admin/src/navigation/motion.ts): the released swipe runs the same
// transition a tapped Back does.

const HORIZONTAL_LOCK_SLOP_PX = 8

export type PhoneBackSwipeSample = {
  clientX: number
  clientY: number
  time: number
}

export type PhoneBackSwipeOutcome = 'cancel' | 'commit'

// A drag is claimed only once it is unambiguously horizontal: past the slop
// with clear horizontal dominance. Anything steeper stays with the scroller,
// which has already handled the touch natively because the listener is
// passive until the claim.
export const isPhoneBackSwipeHorizontal = (
  dx: number,
  dy: number,
): boolean => {
  const ax = Math.abs(dx)
  const ay = Math.abs(dy)
  return ax >= HORIZONTAL_LOCK_SLOP_PX && ax > ay * 1.5
}

export const isPhoneBackSwipeVertical = (
  dx: number,
  dy: number,
): boolean => {
  const ax = Math.abs(dx)
  const ay = Math.abs(dy)
  return ay >= HORIZONTAL_LOCK_SLOP_PX && ay > ax
}

// Instantaneous velocity over the tail of the gesture (px/ms, positive when
// travelling right). A short window keeps a last-instant flick decisive even
// after a slow drag; returns 0 when the samples cannot support an estimate.
export const phoneBackSwipeVelocity = (
  samples: readonly PhoneBackSwipeSample[],
): number => {
  const last = samples.at(-1)
  if (!last || samples.length < 2) return 0
  const WINDOW_MS = 100
  let first = samples[0] ?? last
  for (let i = samples.length - 2; i >= 0; i -= 1) {
    const sample = samples[i]
    if (!sample || last.time - sample.time >= WINDOW_MS) break
    first = sample
  }
  const dt = last.time - first.time
  // A tail shorter than one frame cannot support an estimate — every
  // delivered sample may share one timestamp (coalesced moves, synthetic
  // events) — and must not read as an infinite flick.
  if (dt < 8) return 0
  return (last.clientX - first.clientX) / dt
}

// Commit requires meaningful travel — a flick alone never commits below the
// minimum progress, so a horizontal adjustment on an ordinary control (a
// slider thumb, a carousel) resting near the edge cannot navigate away. Once
// the drag has real distance, either the distance ratio or a fast release
// completes it. Reduced motion changes only how the settle looks (zero
// duration), never the decision: the same distance and velocity thresholds
// apply, because a lower bar would make a faint touch navigate away.
export const resolvePhoneBackSwipeOutcome = ({
  progress,
  velocity,
}: {
  progress: number
  velocity: number
}): PhoneBackSwipeOutcome => {
  if (progress <= 0) return 'cancel'
  if (progress >= PHONE_BACK_SWIPE_COMMIT_RATIO) return 'commit'
  if (
    progress >= PHONE_BACK_SWIPE_FLICK_MIN_PROGRESS
    && velocity >= PHONE_BACK_SWIPE_COMMIT_VELOCITY_PX_PER_MS
  ) {
    return 'commit'
  }
  return 'cancel'
}

// Explicit opt-out for surfaces that own their horizontal drags: an
// ancestor marked data-phone-back-swipe-ignore disables the gesture for any
// touch starting inside it.
export const PHONE_BACK_SWIPE_IGNORE_ATTRIBUTE = 'data-phone-back-swipe-ignore'

// Text editing owns its horizontal drags (caret placement, selection), so an
// edge touch starting inside an editable element never arms the back-swipe —
// the same exclusion native controllers apply.
const PHONE_BACK_SWIPE_EDITABLE_SELECTOR =
  'input, textarea, select, [contenteditable="true"]'

// The DOM half of the claim gate: editing surfaces and explicit opt-out
// ancestors refuse the gesture, and a horizontally scrollable ancestor keeps
// its own pans (carousels, tab strips, horizontal scrollers). Returns true
// when the touch may arm the back-swipe. Pure given an Element; no listeners.
export const isPhoneBackSwipeClaimableTarget = (
  target: EventTarget | null,
): boolean => {
  if (!(target instanceof Element)) return true
  if (target.closest(`[${PHONE_BACK_SWIPE_IGNORE_ATTRIBUTE}]`)) return false
  if (target.closest(PHONE_BACK_SWIPE_EDITABLE_SELECTOR)) return false
  for (
    let element: Element | null = target;
    element;
    element = element.parentElement
  ) {
    const scrollable = element.scrollWidth - element.clientWidth > 1
    if (!scrollable) continue
    const overflowX = getComputedStyle(element).overflowX
    if (overflowX === 'auto' || overflowX === 'scroll') return false
  }
  return true
}
