import { useEffect, useRef, type RefObject } from 'react'
import { isReactNativeWebView } from '../lib/mobile-shell'

// Pull-to-refresh, owned by the web (docs/navigation/overview.md §13): the native
// WebView's own gesture was iOS-only, forced bounces, reloaded the whole
// document from any screen and told the web nothing, and Android had none.
// The web owns the gesture at the top of a Root or Detail page scroller that
// contains no message feed. Past the threshold it does a *content-only*
// refresh — it re-fetches the visible page's data through the caller's
// `onRefresh`, leaving the shell, nav and route/scroll untouched. The full app
// refresh stays a deliberate act: the tablet "Full refresh" nav button and
// Cmd/Ctrl-R (`requestNativeFullRefresh` / `installReloadShortcut`). Boards,
// editors and any surface embedding a feed never offer the pull.

export const PULL_THRESHOLD_PX = 72
// Rubber-band: the indicator travels this fraction of the finger.
const PULL_RESISTANCE = 0.5
export const FEED_MARKER = 'data-message-feed'

export type PullOutcome = 'refresh' | 'cancel'

export type PullGesture = {
  // Begins a pull only from the top of the scroller.
  start: (y: number, scrollTop: number) => void
  // The rubber-banded travel in px, or null when no pull is armed.
  move: (y: number) => number | null
  end: () => PullOutcome
}

export const createPullGesture = (threshold = PULL_THRESHOLD_PX): PullGesture => {
  let startY: number | null = null
  let travel = 0
  return {
    start: (y, scrollTop) => {
      startY = scrollTop <= 0 ? y : null
      travel = 0
    },
    move: (y) => {
      if (startY === null) return null
      const dy = y - startY
      if (dy <= 0) {
        travel = 0
        return 0
      }
      travel = dy * PULL_RESISTANCE
      return travel
    },
    end: () => {
      const outcome: PullOutcome = startY !== null && travel >= threshold ? 'refresh' : 'cancel'
      startY = null
      travel = 0
      return outcome
    },
  }
}

// A scroller offers the gesture only when it holds no feed: a conversation
// scrolls its own way and a refresh there would throw the reader's place.
export const scrollerCanRefresh = (scroller: Element): boolean =>
  scroller.querySelector(`[${FEED_MARKER}]`) === null

export type UsePullToRefreshOptions = {
  enabled: boolean
  indicatorRef: RefObject<HTMLElement | null>
  scrollerRef: RefObject<HTMLElement | null>
  // Re-fetch the visible page's data. Resolves when the refetch settles, so the
  // spinner spins for the duration and then retracts. A content-only refresh:
  // the app shell, nav and route/scroll state are left untouched.
  onRefresh: () => Promise<unknown>
}

export const usePullToRefresh = ({
  enabled,
  indicatorRef,
  scrollerRef,
  onRefresh,
}: UsePullToRefreshOptions): void => {
  // Held in a ref so a fresh `onRefresh` closure each render never re-subscribes
  // the touch listeners; the effect keys only on the structural inputs.
  const onRefreshRef = useRef(onRefresh)
  onRefreshRef.current = onRefresh
  useEffect(() => {
    const scroller = scrollerRef.current
    if (!enabled || !scroller || !isReactNativeWebView()) return undefined
    const gesture = createPullGesture()
    // While a content refresh is in flight the gesture is inert and the spinner
    // is pinned, spinning, until the refetch settles.
    let refreshing = false
    const paint = (travel: number | null) => {
      const indicator = indicatorRef.current
      if (!indicator) return
      const shown = travel !== null && travel > 0
      indicator.style.opacity = shown ? String(Math.min(1, (travel ?? 0) / PULL_THRESHOLD_PX)) : '0'
      indicator.style.transform = `translate3d(0, ${Math.min(travel ?? 0, PULL_THRESHOLD_PX * 1.25)}px, 0)`
      indicator.dataset.armed = travel !== null && travel >= PULL_THRESHOLD_PX ? 'true' : 'false'
    }
    const setRefreshing = (active: boolean) => {
      const indicator = indicatorRef.current
      if (indicator) {
        indicator.dataset.armed = 'false'
        indicator.dataset.refreshing = active ? 'true' : 'false'
        if (active) indicator.style.opacity = '1'
      }
      if (!active) paint(null)
    }
    const onStart = (event: TouchEvent) => {
      if (refreshing) return
      const touch = event.touches[0]
      if (!touch || event.touches.length !== 1 || !scrollerCanRefresh(scroller)) return
      gesture.start(touch.clientY, scroller.scrollTop)
    }
    const onMove = (event: TouchEvent) => {
      if (refreshing) return
      const touch = event.touches[0]
      if (!touch) return
      paint(gesture.move(touch.clientY))
    }
    const onEnd = () => {
      if (refreshing) return
      const outcome = gesture.end()
      if (outcome !== 'refresh') {
        paint(null)
        return
      }
      refreshing = true
      setRefreshing(true)
      void Promise.resolve(onRefreshRef.current())
        .catch(() => undefined)
        .finally(() => {
          refreshing = false
          setRefreshing(false)
        })
    }
    scroller.addEventListener('touchstart', onStart, { passive: true })
    scroller.addEventListener('touchmove', onMove, { passive: true })
    scroller.addEventListener('touchend', onEnd, { passive: true })
    scroller.addEventListener('touchcancel', onEnd, { passive: true })
    return () => {
      scroller.removeEventListener('touchstart', onStart)
      scroller.removeEventListener('touchmove', onMove)
      scroller.removeEventListener('touchend', onEnd)
      scroller.removeEventListener('touchcancel', onEnd)
    }
  }, [enabled, indicatorRef, scrollerRef])
}
