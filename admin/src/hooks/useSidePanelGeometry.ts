import { useCallback, useEffect, useState } from 'react'

export const SIDE_PANEL_DEFAULT_WIDTH = 400
export const SIDE_PANEL_MIN_WIDTH = 320

// Drag-resize bounds for a right-hand side panel: never narrower than the
// Slack-style minimum and never wider than half the viewport.
export const clampSidePanelWidth = (width: number, viewportWidth: number): number => {
  if (!Number.isFinite(width)) {
    return SIDE_PANEL_DEFAULT_WIDTH
  }
  const max = Math.max(SIDE_PANEL_MIN_WIDTH, Math.floor(viewportWidth / 2))
  return Math.min(Math.max(Math.round(width), SIDE_PANEL_MIN_WIDTH), max)
}

// Read a persisted panel width, tolerating missing/garbage values.
export const readSidePanelWidth = (
  stored: string | null,
  viewportWidth: number,
): number => clampSidePanelWidth(stored === null ? Number.NaN : Number(stored), viewportWidth)

/**
 * Width state for a drag-resizable right-hand panel.
 *
 * Lifted out of `useReplyThread` when the agent-screen panel arrived: two
 * panels that disagreed about clamping, persistence timing, or what a
 * temporary viewport shrink does to a stored preference would be the drift
 * Rule zero names. The storage key is a parameter so each panel remembers its
 * own width.
 *
 * Continuous drag geometry is on the responsive plan's geometry allowlist
 * (docs/plans/2026-08-13-responsive-coherence.md §C.5): the 50vw maximum moves
 * continuously with the window, so the band store cannot carry it.
 */
export type SidePanelGeometry = {
  panelWidth: number
  viewportWidth: number
  /** Mid-gesture: moves the preference only. */
  resizePanel: (next: number) => void
  /** End of gesture: writes the preference once. */
  persistPanelWidth: () => void
  /** Keyboard step: moves and persists together. */
  resizePanelWithKeyboard: (next: number) => void
}

export const useSidePanelGeometry = (storageKey: string): SidePanelGeometry => {
  const [viewportWidth, setViewportWidth] = useState(() => window.innerWidth)
  // The stored value is the person's *preferred* width; the rendered width is
  // that preference derived against the current bounds, so a temporary
  // viewport shrink never destroys what they chose.
  const [preferredWidth, setPreferredWidth] = useState(() =>
    readSidePanelWidth(window.localStorage.getItem(storageKey), window.innerWidth),
  )
  const panelWidth = clampSidePanelWidth(preferredWidth, viewportWidth)

  useEffect(() => {
    const onResize = () => setViewportWidth(window.innerWidth)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  const resizePanel = useCallback((next: number) => {
    setPreferredWidth(clampSidePanelWidth(next, window.innerWidth))
  }, [])

  const persistPanelWidth = useCallback(() => {
    setPreferredWidth((current) => {
      window.localStorage.setItem(storageKey, String(current))
      return current
    })
  }, [storageKey])

  const resizePanelWithKeyboard = useCallback((next: number) => {
    const clamped = clampSidePanelWidth(next, window.innerWidth)
    setPreferredWidth(clamped)
    window.localStorage.setItem(storageKey, String(clamped))
  }, [storageKey])

  return {
    panelWidth,
    viewportWidth,
    resizePanel,
    persistPanelWidth,
    resizePanelWithKeyboard,
  }
}
