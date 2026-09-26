import { createGesture, type GestureDetail } from '@ionic/core'
import { useLayoutEffect, useRef, type RefObject } from 'react'
import { flushSync } from 'react-dom'
import { holdStackProgress, runStackTransition, type StackTransitionRun } from '../../navigation/motion'
import { beginStackTransition } from '../../navigation/transition-state'
import {
  PHONE_BACK_SWIPE_EDGE_PX,
  isPhoneBackSwipeClaimableTarget,
  resolvePhoneBackSwipeOutcome,
} from '../../navigation/phone-navigation-gesture'

type Options = {
  enabled: boolean
  layerKey: string
  onCommit: () => void
  onSettleStart?: (outcome: 'cancel' | 'commit', durationMs: number) => void
  reducedMotion: boolean
  viewportRef: RefObject<HTMLDivElement | null>
}

// Ionic owns recognition, pointer lifetimes and frame scheduling. The shared
// navigation stack owns eligibility, poses and Back. A finger never schedules
// a React render of the retained pages.
export const usePhoneBackSwipeGesture = (options: Options): void => {
  const latest = useRef(options)
  latest.current = options
  const { enabled, layerKey, viewportRef } = options

  useLayoutEffect(() => {
    const viewport = viewportRef.current
    if (!viewport || !enabled) return undefined
    let startX = 0
    let width = 1
    let peak = 0
    let lastMoveAt = 0
    let top: HTMLElement | null = null
    let bottom: HTMLElement | null = null
    let restorePose: (() => void) | null = null
    let endTransition: (() => void) | null = null
    let commit: (() => void) | null = null
    let settle: StackTransitionRun | null = null
    let timer: number | undefined
    let disposed = false
    let committing = false

    const cleanup = () => {
      window.clearTimeout(timer)
      settle?.cancel()
      settle = null
      restorePose?.()
      restorePose = null
      endTransition?.()
      endTransition = null
      commit = null
      viewport.dataset.phoneNavigationGesture = 'idle'
    }
    const progressOf = (detail: GestureDetail) =>
      Math.max(0, Math.min((detail.currentX - startX) / width, 1))

    const move = (detail: GestureDetail) => {
      if (!top || !bottom || !commit || disposed) return
      if ((detail.event as TouchEvent).touches.length !== 1) {
        cleanup()
        return
      }
      if (detail.event.cancelable) detail.event.preventDefault()
      const progress = progressOf(detail)
      peak = Math.max(peak, progress)
      lastMoveAt = detail.currentTime
      restorePose?.()
      restorePose = holdStackProgress(top, bottom, progress)
    }

    const finish = (run: StackTransitionRun, outcome: 'cancel' | 'commit') => {
      if (settle !== run || disposed || committing) return
      const performBack = commit
      // Hold the animation's final pose until React has committed the new
      // layer. Browser history pops arrive asynchronously, even in flushSync:
      // only the layer-key effect's cleanup may release a committed pose.
      if (outcome === 'commit') {
        committing = true
        flushSync(() => performBack?.())
      } else cleanup()
    }

    const gesture = createGesture({
      el: viewport,
      gestureName: 'nessie-stack-back',
      gesturePriority: 40,
      direction: 'x',
      threshold: 8,
      maxAngle: 33,
      passive: false,
      canStart: (detail) => {
        const event = detail.event as TouchEvent
        if (!latest.current.enabled || commit || settle) return false
        if (event.type !== 'touchstart' || event.touches.length !== 1) return false
        if (detail.startX > PHONE_BACK_SWIPE_EDGE_PX) return false
        if (!isPhoneBackSwipeClaimableTarget(event.target)) return false
        startX = detail.startX
        width = viewport.clientWidth || 1
        peak = 0
        return true
      },
      onStart: (detail) => {
        if (detail.currentX <= startX || !latest.current.enabled) return
        top = viewport.querySelector('[data-phone-navigation-layer="current"]')
        bottom = viewport.querySelector('[data-phone-navigation-layer="underlay"]')
        if (!top || !bottom) return
        // Capture this layer's immutable Back, so a new owner cannot steal a
        // gesture already in progress. The signal also defers data redirects.
        commit = latest.current.onCommit
        endTransition = beginStackTransition()
        viewport.dataset.phoneNavigationGesture = 'dragging'
        move(detail)
      },
      onMove: move,
      onEnd: (detail) => {
        if (!commit || disposed || !top || !bottom) return
        const progress = progressOf(detail)
        const cancelled = detail.event.type === 'touchcancel'
        const reversed = progress < Math.max(0, peak - 0.06)
        const outcome = cancelled || reversed ? 'cancel' : resolvePhoneBackSwipeOutcome({
          progress,
          velocity: detail.currentTime - lastMoveAt >= 100 ? 0 : detail.velocityX,
        })
        if (detail.event.cancelable) detail.event.preventDefault()
        restorePose?.()
        restorePose = holdStackProgress(top, bottom, progress)
        viewport.dataset.phoneNavigationGesture = 'settling'
        const run = runStackTransition({
          top,
          bottom,
          direction: outcome === 'commit' ? 'back' : 'forward',
          progress,
          reducedMotion: latest.current.reducedMotion || document.visibilityState === 'hidden',
        })
        settle = run
        latest.current.onSettleStart?.(outcome, run.durationMs)
        void run.finished.then(() => finish(run, outcome))
        timer = window.setTimeout(() => finish(run, outcome), run.durationMs + 180)
      },
    })
    gesture.enable()
    const onVisibilityChange = () => {
      if (document.visibilityState !== 'hidden') return
      // Leaving the app cancels an unfinished gesture. It must not execute a
      // delayed Back against a screen the person returns to later.
      cleanup()
      gesture.enable(false)
      gesture.enable()
    }
    document.addEventListener('visibilitychange', onVisibilityChange)
    return () => {
      disposed = true
      gesture.destroy()
      document.removeEventListener('visibilitychange', onVisibilityChange)
      cleanup()
    }
  }, [enabled, layerKey, viewportRef])
}
