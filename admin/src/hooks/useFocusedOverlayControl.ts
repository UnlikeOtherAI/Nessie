import { useEffect, type RefObject } from 'react'

// A field should not touch the visible viewport's edge: the small margin makes
// the active control legible above a phone keyboard and gives its focus ring
// room to render.
const FOCUS_MARGIN_PX = 12
const PANEL_EDGE_GUTTER_PX = 32

type VisibleBounds = {
  bottom: number
  top: number
}

const visibleBoundsFor = (panel: HTMLElement): VisibleBounds => {
  const panelBounds = panel.getBoundingClientRect()
  const viewport = panel.ownerDocument.defaultView?.visualViewport
  if (!viewport) return panelBounds

  const top = Math.max(panelBounds.top, viewport.offsetTop)
  const bottom = Math.min(panelBounds.bottom, viewport.offsetTop + viewport.height)

  // A transient viewport report must not make a control impossible to reveal.
  return top < bottom ? { bottom, top } : panelBounds
}

const scrollRootFor = (panel: HTMLElement, target: HTMLElement): HTMLElement => {
  const ownerWindow = panel.ownerDocument.defaultView
  let current: HTMLElement | null = target.parentElement

  while (current && panel.contains(current)) {
    const overflowY = ownerWindow?.getComputedStyle(current).overflowY
    if (current === panel || overflowY === 'auto' || overflowY === 'scroll') {
      return current
    }
    current = current.parentElement
  }

  return panel
}

const applyVisualViewportHeight = (panel: HTMLElement): void => {
  const ownerWindow = panel.ownerDocument.defaultView
  const viewport = ownerWindow?.visualViewport
  const scrim = panel.parentElement
  if (!ownerWindow || !viewport) {
    panel.style.removeProperty('--overlay-visible-height')
    scrim?.style.removeProperty('--overlay-visual-inset')
    return
  }

  const height = Math.max(0, Math.round(viewport.height - PANEL_EDGE_GUTTER_PX))
  const inset = Math.max(0, Math.round(ownerWindow.innerHeight - viewport.height - viewport.offsetTop))
  panel.style.setProperty('--overlay-visible-height', `${height}px`)
  scrim?.style.setProperty('--overlay-visual-inset', `${inset}px`)
}

/**
 * Scrolls an overlay's nearest local scroll root just enough to expose a
 * focused child.
 *
 * `Element.scrollIntoView()` is deliberately not used here: it climbs every
 * scroll ancestor, so a field inside a portalled dialog can also move the app
 * behind its scrim. The Visual Viewport bounds are narrower than a fixed
 * panel while a phone keyboard is open, which is the missing boundary native
 * browser focus handling cannot always infer.
 */
export const revealFocusedOverlayControl = (
  panel: HTMLElement,
  target: Element | null = panel.ownerDocument.activeElement,
): void => {
  const ownerWindow = panel.ownerDocument.defaultView
  if (!ownerWindow || !(target instanceof ownerWindow.HTMLElement) || !panel.contains(target)) return

  const scrollRoot = scrollRootFor(panel, target)
  const visible = visibleBoundsFor(scrollRoot)
  const control = target.getBoundingClientRect()
  const top = visible.top + FOCUS_MARGIN_PX
  const bottom = visible.bottom - FOCUS_MARGIN_PX

  if (control.top < top) {
    scrollRoot.scrollTop += control.top - top
  } else if (control.bottom > bottom) {
    scrollRoot.scrollTop += control.bottom - bottom
  }
}

/**
 * Keep the active field visible after both focus changes and Visual Viewport
 * changes. The latter is essential on iOS, where focus happens before the
 * soft keyboard reports its final viewport height.
 */
export const useFocusedOverlayControl = (
  panelRef: RefObject<HTMLElement | null>,
  enabled: boolean,
): void => {
  useEffect(() => {
    if (!enabled) return undefined
    const panel = panelRef.current
    const ownerWindow = panel?.ownerDocument.defaultView
    if (!panel || !ownerWindow) return undefined

    let frame: number | undefined
    const reveal = () => {
      applyVisualViewportHeight(panel)
      if (frame !== undefined) ownerWindow.cancelAnimationFrame(frame)
      frame = ownerWindow.requestAnimationFrame(() => {
        frame = undefined
        revealFocusedOverlayControl(panel)
      })
    }

    panel.addEventListener('focusin', reveal)
    ownerWindow.addEventListener('resize', reveal)
    ownerWindow.visualViewport?.addEventListener('resize', reveal)
    ownerWindow.visualViewport?.addEventListener('scroll', reveal)
    reveal()

    return () => {
      if (frame !== undefined) ownerWindow.cancelAnimationFrame(frame)
      panel.removeEventListener('focusin', reveal)
      ownerWindow.removeEventListener('resize', reveal)
      ownerWindow.visualViewport?.removeEventListener('resize', reveal)
      ownerWindow.visualViewport?.removeEventListener('scroll', reveal)
    }
  }, [enabled, panelRef])
}
