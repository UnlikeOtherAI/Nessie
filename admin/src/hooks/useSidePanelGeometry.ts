import { useCallback, useEffect, useState } from 'react'

import {
  clampThreadPanelWidth,
  readThreadPanelWidth,
} from '../components/features/channels/thread-panel/thread-panel-helpers'

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
    readThreadPanelWidth(window.localStorage.getItem(storageKey), window.innerWidth),
  )
  const panelWidth = clampThreadPanelWidth(preferredWidth, viewportWidth)

  useEffect(() => {
    const onResize = () => setViewportWidth(window.innerWidth)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  const resizePanel = useCallback((next: number) => {
    setPreferredWidth(clampThreadPanelWidth(next, window.innerWidth))
  }, [])

  const persistPanelWidth = useCallback(() => {
    setPreferredWidth((current) => {
      window.localStorage.setItem(storageKey, String(current))
      return current
    })
  }, [storageKey])

  const resizePanelWithKeyboard = useCallback((next: number) => {
    const clamped = clampThreadPanelWidth(next, window.innerWidth)
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
