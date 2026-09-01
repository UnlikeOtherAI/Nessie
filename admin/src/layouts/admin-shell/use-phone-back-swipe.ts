import {
  useEffect,
  useRef,
  useState,
  type RefObject,
} from 'react'
import { runStackTransition, type StackTransitionRun } from '../../navigation/motion'
import { beginStackTransition } from '../../navigation/transition-state'
import {
  PHONE_BACK_SWIPE_EDGE_PX,
  isPhoneBackSwipeClaimableTarget,
  isPhoneBackSwipeHorizontal,
  isPhoneBackSwipeVertical,
  phoneBackSwipeVelocity,
  resolvePhoneBackSwipeOutcome,
  type PhoneBackSwipeSample,
} from './phone-navigation-gesture'

export type PhoneBackSwipeSettle = {
  outcome: 'cancel' | 'commit'
  // Layer displacement (0..1) at the release point; the settle keyframes
  // interpolate from exactly this inline transform.
  from: number
}

export type PhoneBackSwipeGestureState = {
  // Live layer displacement as a 0..1 fraction of the viewport width; null
  // when no drag is active. During a settle this stays at the release point
  // while the CSS settle animation owns the rest of the travel.
  progress: number | null
  settle: PhoneBackSwipeSettle | null
}

type UsePhoneBackSwipeGestureOptions = {
  // True while the detail still has a live underlay to reveal and the
  // interactive gesture may arm. False arms nothing (tab roots, mid route
  // transition, or a settle already running).
  enabled: boolean
  // One cohesive seam for the gesture's Back action: the release decision
  // calls this at most once, the viewport waits for the settle animation to
  // finish (animationend plus a timer fallback), and only then commits
  // exactly one route update through this callback. The viewport resolves and
  // executes the same immutable route Back action as the shared button, so a
  // local action mounting during the settle cannot steal the gesture.
  onCommit: () => void
  reducedMotion: boolean
  viewportRef: RefObject<HTMLDivElement | null>
}

type DragState = {
  active: boolean
  claimed: boolean
  touchId: number
  startX: number
  startY: number
  width: number
  maxProgress: number
  samples: PhoneBackSwipeSample[]
}

// How far past the peak travel a release must fall before a leftward
// reversal reads as deliberate keep-the-detail intent.
const REVERSAL_HYSTERESIS = 0.06
const MAX_SAMPLES = 12

const findTrackedTouch = (
  event: TouchEvent,
  touchId: number,
): Touch | null =>
  Array.from(event.changedTouches)
    .find((candidate) => candidate.identifier === touchId) ?? null

// The single interactive phone Back. Listens on the viewport, claims only
// edge-started unambiguously horizontal drags, mirrors the finger into the
// layer transforms, and settles to at most one commit action per drag — a
// vertical scroll, a leftward reversal, a non-edge start, an editing target,
// an opted-out or horizontally scrollable ancestor, or a touch below the
// travel threshold never calls onCommit. Nothing is prevented before the
// claim, so those touches keep their native behaviour.
export const usePhoneBackSwipeGesture = ({
  enabled,
  onCommit,
  reducedMotion,
  viewportRef,
}: UsePhoneBackSwipeGestureOptions): PhoneBackSwipeGestureState => {
  const [progress, setProgress] = useState<number | null>(null)
  const [settle, setSettle] = useState<PhoneBackSwipeSettle | null>(null)
  const drag = useRef<DragState | null>(null)
  const settleTimer = useRef<number | null>(null)
  const enabledRef = useRef(enabled)
  enabledRef.current = enabled
  const onCommitRef = useRef(onCommit)
  onCommitRef.current = onCommit
  const reducedMotionRef = useRef(reducedMotion)
  reducedMotionRef.current = reducedMotion
  const settleRef = useRef<PhoneBackSwipeSettle | null>(null)
  settleRef.current = settle

  useEffect(() => {
    const viewport = viewportRef.current
    if (!viewport) return undefined

    const clearSettleTimer = () => {
      if (settleTimer.current !== null) {
        window.clearTimeout(settleTimer.current)
        settleTimer.current = null
      }
    }

    // The settle is the same runStackTransition every route push and pop
    // uses, started from exactly the released position (held by the layers'
    // inline transforms) and scaled to the travel that remains, so the motion
    // continues from where the finger lifted with no jump and no CSS replay.
    let settleRun: StackTransitionRun | null = null
    let endSettleTransition: (() => void) | null = null

    // Closing a settle cancels the run and removes every inline transform. A
    // cancel ends back on the detail; a commit ends with the route still on
    // the detail — only then does onCommit perform the single route update,
    // and the root the settle revealed becomes the current layer at identity
    // in the same commit, so no animation replays.
    const closeSettle = (outcome: 'cancel' | 'commit') => {
      clearSettleTimer()
      settleRun?.cancel()
      settleRun = null
      endSettleTransition?.()
      endSettleTransition = null
      setSettle(null)
      setProgress(null)
      if (outcome === 'commit') onCommitRef.current()
    }

    const openSettle = (outcome: 'cancel' | 'commit', from: number) => {
      clearSettleTimer()
      setSettle({ outcome, from })
      // A superseded forward transition may already be mid-flight: the layer
      // under the finger is then labelled "outgoing" (not yet "current") and
      // its underlay "incoming". Settle whichever pair the DOM actually
      // shows so the gesture's motion always continues from the finger.
      const topLayer = viewport.querySelector(
        '[data-phone-navigation-layer="current"], [data-phone-navigation-layer="outgoing"]',
      )
      const bottomLayer = viewport.querySelector(
        '[data-phone-navigation-layer="underlay"], [data-phone-navigation-layer="incoming"]',
      )
      // A commit reveals the lower layer (a Back); a cancel returns the top
      // layer to rest over it (the geometry of a forward push).
      const run = runStackTransition({
        top: topLayer,
        bottom: bottomLayer,
        direction: outcome === 'commit' ? 'back' : 'forward',
        progress: from,
        // Reduced motion keeps the claim and the thresholds and drops only
        // the motion: the settle still runs, at zero duration, through the
        // same completion path.
        reducedMotion: reducedMotionRef.current,
      })
      settleRun = run
      endSettleTransition = beginStackTransition()
      void run.finished.then(() => {
        if (settleRun !== run) return
        const pending = settleRef.current
        if (pending) closeSettle(pending.outcome)
      })
      // Fallback for a discarded finish event.
      settleTimer.current = window.setTimeout(
        () => closeSettle(outcome),
        run.durationMs + 180,
      )
    }

    const release = (state: DragState, event: TouchEvent, cancelled: boolean) => {
      drag.current = null
      if (!state.claimed || cancelled) {
        // A cancelled or never-claimed touch is a full cancel: no route
        // change and no residual layer transform.
        setProgress(null)
        return
      }
      const touch = findTrackedTouch(event, state.touchId)
      const dx = touch ? touch.clientX - state.startX : 0
      const releasedProgress = Math.max(0, Math.min(dx / state.width, 1))
      const velocity = phoneBackSwipeVelocity(state.samples)
      // Leftward intent after a commit-worthy pull is a deliberate keep:
      // past the hysteresis it settles back instead of navigating. Distance,
      // rather than a noisy last-sample velocity, is the stable signal here.
      const reversed =
        releasedProgress < Math.max(0, state.maxProgress - REVERSAL_HYSTERESIS)
      const outcome = reversed
        ? 'cancel'
        : resolvePhoneBackSwipeOutcome({
            progress: releasedProgress,
            velocity,
          })
      if (event.cancelable) event.preventDefault()
      setProgress(releasedProgress)
      openSettle(outcome, releasedProgress)
    }

    const onTouchStart = (event: TouchEvent) => {
      if (!enabledRef.current) return
      if (settleRef.current) return
      if (event.touches.length !== 1) return
      const touch = event.touches[0]
      if (!touch || touch.clientX > PHONE_BACK_SWIPE_EDGE_PX) return
      if (!isPhoneBackSwipeClaimableTarget(event.target)) return
      drag.current = {
        active: true,
        claimed: false,
        maxProgress: 0,
        samples: [{
          clientX: touch.clientX,
          clientY: touch.clientY,
          time: event.timeStamp,
        }],
        startX: touch.clientX,
        startY: touch.clientY,
        touchId: touch.identifier,
        width: viewport.clientWidth || 1,
      }
    }

    const track = (event: TouchEvent): DragState | null => {
      const current = drag.current
      if (!current?.active) return null
      const touch = findTrackedTouch(event, current.touchId)
      if (!touch) return null
      current.samples.push({
        clientX: touch.clientX,
        clientY: touch.clientY,
        time: event.timeStamp,
      })
      if (current.samples.length > MAX_SAMPLES) current.samples.shift()
      return current
    }

    const onTouchMove = (event: TouchEvent) => {
      const current = track(event)
      if (!current) return
      const touch = findTrackedTouch(event, current.touchId)
      if (!touch) return
      const dx = touch.clientX - current.startX
      const dy = touch.clientY - current.startY

      if (!current.claimed) {
        if (isPhoneBackSwipeVertical(dx, dy) || (dx < -4 && Math.abs(dx) > Math.abs(dy))) {
          // Never our gesture: hand the touch back to the scroller or the
          // horizontal control under the finger.
          current.active = false
          drag.current = null
          return
        }
        if (!isPhoneBackSwipeHorizontal(dx, dy)) return
        current.claimed = true
      }

      if (event.cancelable) event.preventDefault()
      const nextProgress = Math.max(0, Math.min(dx / current.width, 1))
      current.maxProgress = Math.max(current.maxProgress, nextProgress)
      setProgress(nextProgress)
    }

    const onTouchEnd = (event: TouchEvent) => {
      const current = track(event) ?? drag.current
      if (!current?.active) return
      release(current, event, false)
    }
    const onTouchCancel = (event: TouchEvent) => {
      const current = track(event) ?? drag.current
      if (!current?.active) return
      release(current, event, true)
    }

    // The settle animation's finish (or the fallback timer) is the only
    // moment a commit route update may fire.
    viewport.addEventListener('touchstart', onTouchStart, { passive: true })
    viewport.addEventListener('touchmove', onTouchMove, { passive: false })
    viewport.addEventListener('touchend', onTouchEnd, { passive: false })
    viewport.addEventListener('touchcancel', onTouchCancel, { passive: true })

    return () => {
      viewport.removeEventListener('touchstart', onTouchStart)
      viewport.removeEventListener('touchmove', onTouchMove)
      viewport.removeEventListener('touchend', onTouchEnd)
      viewport.removeEventListener('touchcancel', onTouchCancel)
      clearSettleTimer()
      settleRun?.cancel()
      settleRun = null
      endSettleTransition?.()
      endSettleTransition = null
      drag.current = null
    }
  }, [viewportRef])

  return { progress, settle }
}
