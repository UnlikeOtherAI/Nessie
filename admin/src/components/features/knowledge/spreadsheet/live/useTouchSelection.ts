import { useEffect, useState } from 'react'
import type { Model } from '@ironcalc/wasm'
import type { SpreadsheetSelection } from '@nessie/schemas'
import { cellFromPoint, cellRect, HEADER_COLUMN_WIDTH, HEADER_ROW_HEIGHT } from '../spreadsheet-geometry'

/**
 * Range selection with a finger: long-press, then drag, with a handle on each
 * end of the range.
 *
 * IronCalc's own `usePointer` ignores non-mouse pointers, so a touch drag over
 * the grid selects one cell and scrolls. This is Spike D's prototype, ported
 * rather than reinvented: the timings, the slop threshold and the non-passive
 * `touchmove` are the values that were **measured working in real Mobile
 * Safari on iOS 26.5**, not guesses (spike-cd-render-touch.md §"Spike D").
 *
 * Two things in it are load-bearing and look like noise:
 *
 *  - the `touchmove` listener is non-passive and registered on the container.
 *    Safari reads `touch-action` at gesture start, so once a finger is already
 *    down only a `preventDefault()` on a non-passive listener holds the scroll
 *    back. `touch-action: none` alone was measured *not* to be enough.
 *  - movement before the timer fires cancels it. That is what keeps a plain
 *    drag scrolling normally: the gesture only becomes a selection if the
 *    finger stayed still long enough to mean it.
 *
 * What the spike left for this phase and this file adds: the handles follow a
 * scroll and a resize (the prototype painted them once), and the geometry is
 * the shared `spreadsheet-geometry.ts`, which handles frozen panes — the one
 * case the prototype skipped.
 */

export const LONG_PRESS_MS = 350
/** Movement past this before the timer means the person meant to scroll. */
export const SLOP_PX = 10

export type TouchSelectionHandle = { key: string; left: number; top: number }

export type TouchSelectionState = {
  /** True while a finger is extending a range: the container must not scroll. */
  selecting: boolean
  /** Handle positions in the *bounds* element's frame, or empty. */
  handles: TouchSelectionHandle[]
}

type Options = {
  /** The element the handles are positioned against (the pane's grid box). */
  bounds: HTMLElement | null
  canEdit: boolean
  /** IronCalc's scroll element — the frame `cellRect`/`cellFromPoint` answer in. */
  container: HTMLElement | null
  model: Model | null
  /** Bumped after every applied batch, so the handles re-measure. */
  revision: number
  /** Called after the model's selection changed, so the pane can redraw. */
  onChanged: () => void
  sheet: number
}

const normalise = (
  anchor: [number, number],
  head: [number, number],
): SpreadsheetSelection => ({
  r0: Math.min(anchor[0], head[0]),
  r1: Math.max(anchor[0], head[0]),
  c0: Math.min(anchor[1], head[1]),
  c1: Math.max(anchor[1], head[1]),
})

export const useTouchSelection = ({
  bounds,
  canEdit,
  container,
  model,
  onChanged,
  revision,
  sheet,
}: Options): TouchSelectionState => {
  const [state, setState] = useState<TouchSelectionState>({ handles: [], selecting: false })

  useEffect(() => {
    if (!model || !container || !bounds || !canEdit) {
      setState({ handles: [], selecting: false })
      return undefined
    }

    let anchor: [number, number] | null = null
    let head: [number, number] | null = null
    let origin: { x: number; y: number } | null = null
    let timer: ReturnType<typeof setTimeout> | null = null
    let selecting = false
    let captured: number | null = null

    const point = (event: PointerEvent): [number, number] => {
      const frame = container.getBoundingClientRect()
      return [event.clientX - frame.left, event.clientY - frame.top]
    }

    const paint = (): void => {
      if (!anchor || !head) { setState({ handles: [], selecting }); return }
      const range = normalise(anchor, head)
      const frame = container.getBoundingClientRect()
      const origin2 = bounds.getBoundingClientRect()
      const dx = frame.left - origin2.left
      const dy = frame.top - origin2.top
      const start = cellRect(model, sheet, range.r0, range.c0)
      const end = cellRect(model, sheet, range.r1, range.c1)
      const handles: TouchSelectionHandle[] = []
      const push = (key: string, left: number, top: number): void => {
        // A handle scrolled behind a header or off the far edge has nowhere
        // honest to sit; drawing it there would point at the wrong cell.
        if (left < HEADER_COLUMN_WIDTH || top < HEADER_ROW_HEIGHT) return
        if (left > frame.width || top > frame.height) return
        handles.push({ key, left: dx + left, top: dy + top })
      }
      push('start', start.left, start.top)
      push('end', end.left + end.width, end.top + end.height)
      setState({ handles, selecting })
    }

    const clearTimer = (): void => {
      if (timer !== null) clearTimeout(timer)
      timer = null
    }

    const release = (event?: PointerEvent): void => {
      clearTimer()
      origin = null
      if (captured !== null) {
        try { container.releasePointerCapture(captured) } catch { /* already gone */ }
        captured = null
      }
      void event
      if (!selecting) return
      selecting = false
      paint()
    }

    const onPointerDown = (event: PointerEvent): void => {
      if (event.pointerType !== 'touch') return
      const [x, y] = point(event)
      origin = { x, y }
      clearTimer()
      timer = setTimeout(() => {
        timer = null
        anchor = cellFromPoint(model, sheet, x, y)
        head = anchor
        selecting = true
        model.setSelectedCell(anchor[0], anchor[1])
        onChanged()
        paint()
        try {
          container.setPointerCapture(event.pointerId)
          captured = event.pointerId
        } catch { /* a capture the browser refuses costs only the drag's tail */ }
      }, LONG_PRESS_MS)
    }

    const onPointerMove = (event: PointerEvent): void => {
      if (event.pointerType !== 'touch') return
      const [x, y] = point(event)
      if (!selecting) {
        // Movement before the timer is a scroll: hand it back to the browser.
        if (origin && Math.hypot(x - origin.x, y - origin.y) > SLOP_PX) clearTimer()
        return
      }
      event.preventDefault()
      if (!anchor) return
      head = cellFromPoint(model, sheet, x, y)
      model.setSelectedRange(anchor[0], anchor[1], head[0], head[1])
      onChanged()
      paint()
    }

    const onTouchMove = (event: TouchEvent): void => {
      if (selecting) event.preventDefault()
    }

    container.addEventListener('pointerdown', onPointerDown)
    container.addEventListener('pointermove', onPointerMove)
    container.addEventListener('pointerup', release)
    container.addEventListener('pointercancel', release)
    // Non-passive, and this is the one that actually holds the scroll back
    // once a finger is already down (measured on iOS 26.5).
    container.addEventListener('touchmove', onTouchMove, { passive: false })
    container.addEventListener('scroll', paint, { passive: true })
    const observer = new ResizeObserver(paint)
    observer.observe(container)

    return () => {
      clearTimer()
      container.removeEventListener('pointerdown', onPointerDown)
      container.removeEventListener('pointermove', onPointerMove)
      container.removeEventListener('pointerup', release)
      container.removeEventListener('pointercancel', release)
      container.removeEventListener('touchmove', onTouchMove)
      container.removeEventListener('scroll', paint)
      observer.disconnect()
    }
  }, [bounds, canEdit, container, model, onChanged, revision, sheet])

  return state
}
