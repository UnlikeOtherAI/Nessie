import { useEffect, type RefObject } from 'react'
import { isReactNativeWebView, requestNativeFullRefresh } from '../lib/mobile-shell'

// Pull-to-refresh, owned by the web (docs/navigation/overview.md §13): the native
// WebView's own gesture was iOS-only, forced bounces, reloaded the whole
// document from any screen and told the web nothing, and Android had none.
// The web owns the gesture at the top of a Root or Detail page scroller that
// contains no message feed, and asks the shell for the one full refresh it
// already offers (`nessie:full-refresh`). Boards, editors and any surface
// embedding a feed never offer it.

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
}

export const usePullToRefresh = ({ enabled, indicatorRef, scrollerRef }: UsePullToRefreshOptions): void => {
  useEffect(() => {
    const scroller = scrollerRef.current
    if (!enabled || !scroller || !isReactNativeWebView()) return undefined
    const gesture = createPullGesture()
    const paint = (travel: number | null) => {
      const indicator = indicatorRef.current
      if (!indicator) return
      const shown = travel !== null && travel > 0
      indicator.style.opacity = shown ? String(Math.min(1, (travel ?? 0) / PULL_THRESHOLD_PX)) : '0'
      indicator.style.transform = `translate3d(0, ${Math.min(travel ?? 0, PULL_THRESHOLD_PX * 1.25)}px, 0)`
      indicator.dataset.armed = travel !== null && travel >= PULL_THRESHOLD_PX ? 'true' : 'false'
    }
    const onStart = (event: TouchEvent) => {
      const touch = event.touches[0]
      if (!touch || event.touches.length !== 1 || !scrollerCanRefresh(scroller)) return
      gesture.start(touch.clientY, scroller.scrollTop)
    }
    const onMove = (event: TouchEvent) => {
      const touch = event.touches[0]
      if (!touch) return
      paint(gesture.move(touch.clientY))
    }
    const onEnd = () => {
      const outcome = gesture.end()
      paint(null)
      if (outcome === 'refresh') requestNativeFullRefresh()
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
