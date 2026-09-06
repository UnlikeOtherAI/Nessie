import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

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
 * A mounted panel's width, as the panel standing to its right sees it.
 */
export type SidePanelLink = {
  /** The width on screen right now — this panel's preference, clamped. */
  readWidth: () => number
  /** Move the width without writing the preference to storage. */
  setWidth: (next: number) => void
  /** Write the current preference under this panel's storage key. */
  persistWidth: () => void
}

/**
 * The panels that are on screen, by storage key.
 *
 * Every panel's drag handle sits on its own left edge, so when two of them
 * stand side by side the handle between them belongs to the right-hand one.
 * Dragging it used to widen that panel alone: the left panel kept its width
 * and slid sideways as a block, and the reader — who had grabbed the
 * thread↔browser separator — watched the chat↔thread separator move instead.
 *
 * The pair is rendered by unrelated components (`useReplyThread` in the
 * channels page, the agent-screen column inside the tool dock), so the
 * right-hand panel names the storage key of the panel on its left and finds it
 * here. A registry rather than lifted state because the alternative is routing
 * a per-frame drag through the page every panel hangs off.
 */
const livePanels = new Map<string, SidePanelLink>()

/** Publish a panel's geometry for as long as it is on screen. */
export const registerSidePanel = (storageKey: string, link: SidePanelLink): (() => void) => {
  livePanels.set(storageKey, link)
  return () => {
    // Only if the entry is still ours: a remount registers the replacement
    // before the outgoing effect cleans up, and an unconditional delete there
    // would unlink a panel that is standing on screen.
    if (livePanels.get(storageKey) === link) {
      livePanels.delete(storageKey)
    }
  }
}

/** The panel registered under `storageKey`, or null while none is on screen. */
export const findLinkedSidePanel = (storageKey: string | undefined): SidePanelLink | null =>
  (storageKey === undefined ? undefined : livePanels.get(storageKey)) ?? null

export type LinkedSidePanelWidths = {
  width: number
  linkedWidth: number
}

/**
 * Split a requested width between a panel and the one on its left, so the
 * boundary the two share moves and their total does not.
 *
 * Both clamps bind the pair: when either side reaches a bound the gesture
 * stops there for both, because letting the other keep moving would take the
 * difference out of the conversation — which is the bug the linking exists to
 * prevent, in the other direction.
 *
 * The requested width is absolute (`SidePanelShell` recomputes it from the
 * gesture's start each frame), and every applied step preserves the pair's
 * total, so the result is a function of the pointer position alone: dragging
 * past a bound and back resumes exactly where the bound was, with no drift.
 */
export const resolveLinkedSidePanelWidths = (
  currentWidth: number,
  linkedCurrentWidth: number,
  requestedWidth: number,
  viewportWidth: number,
): LinkedSidePanelWidths => {
  const width = clampSidePanelWidth(currentWidth, viewportWidth)
  const linkedWidth = clampSidePanelWidth(linkedCurrentWidth, viewportWidth)
  const requested = clampSidePanelWidth(requestedWidth, viewportWidth) - width
  const own = clampSidePanelWidth(width + requested, viewportWidth) - width
  const linked = linkedWidth - clampSidePanelWidth(linkedWidth - requested, viewportWidth)
  const delta = requested >= 0
    ? Math.max(0, Math.min(own, linked))
    : Math.min(0, Math.max(own, linked))
  return { width: width + delta, linkedWidth: linkedWidth - delta }
}

/**
 * Apply a resize to one panel, or — when a panel is registered to its left —
 * to the boundary the two share. A linked gesture writes both preferences,
 * since it moved both.
 */
export const resizeSidePanelPair = (
  panel: SidePanelLink,
  linked: SidePanelLink | null,
  requestedWidth: number,
  viewportWidth: number,
  persist: boolean,
): void => {
  if (linked === null) {
    panel.setWidth(clampSidePanelWidth(requestedWidth, viewportWidth))
    if (persist) {
      panel.persistWidth()
    }
    return
  }
  const resolved = resolveLinkedSidePanelWidths(
    panel.readWidth(),
    linked.readWidth(),
    requestedWidth,
    viewportWidth,
  )
  panel.setWidth(resolved.width)
  linked.setWidth(resolved.linkedWidth)
  if (persist) {
    panel.persistWidth()
    linked.persistWidth()
  }
}

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

export type SidePanelGeometryOptions = {
  /**
   * Whether the panel this geometry belongs to is actually on screen. A page
   * may hold the geometry open while the panel is closed — `useReplyThread`
   * runs for every conversation, thread or no thread — and a panel nobody can
   * see owns no boundary for its neighbour to push against.
   */
  isPresent?: boolean
  /**
   * Storage key of the panel standing immediately to this one's left. Naming
   * it is unconditional: the link is made only while a panel with that key is
   * on screen, so the caller never has to know whether its neighbour is open.
   */
  linkedLeftKey?: string
}

export const useSidePanelGeometry = (
  storageKey: string,
  { isPresent = true, linkedLeftKey }: SidePanelGeometryOptions = {},
): SidePanelGeometry => {
  const [viewportWidth, setViewportWidth] = useState(() => window.innerWidth)
  // The stored value is the person's *preferred* width; the rendered width is
  // that preference derived against the current bounds, so a temporary
  // viewport shrink never destroys what they chose.
  const [preferredWidth, setPreferredWidth] = useState(() =>
    readSidePanelWidth(window.localStorage.getItem(storageKey), window.innerWidth),
  )
  // The same preference as a value that can be read between renders: a linked
  // drag belongs to the neighbouring panel's gesture, which asks this one for
  // its width from inside a rAF callback, where React state is a frame behind.
  const preferredWidthRef = useRef(preferredWidth)
  const panelWidth = clampSidePanelWidth(preferredWidth, viewportWidth)

  useEffect(() => {
    const onResize = () => setViewportWidth(window.innerWidth)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  const setWidth = useCallback((next: number) => {
    const width = clampSidePanelWidth(next, window.innerWidth)
    preferredWidthRef.current = width
    setPreferredWidth(width)
  }, [])

  const persistWidth = useCallback(() => {
    window.localStorage.setItem(storageKey, String(preferredWidthRef.current))
  }, [storageKey])

  const link = useMemo<SidePanelLink>(
    () => ({
      persistWidth,
      readWidth: () => clampSidePanelWidth(preferredWidthRef.current, window.innerWidth),
      setWidth,
    }),
    [persistWidth, setWidth],
  )

  useEffect(
    () => (isPresent ? registerSidePanel(storageKey, link) : undefined),
    [isPresent, link, storageKey],
  )

  const resizePanel = useCallback((next: number) => {
    resizeSidePanelPair(link, findLinkedSidePanel(linkedLeftKey), next, window.innerWidth, false)
  }, [link, linkedLeftKey])

  const persistPanelWidth = useCallback(() => {
    persistWidth()
    // The gesture that just ended moved the panel on the left too, so its
    // preference is new as well.
    findLinkedSidePanel(linkedLeftKey)?.persistWidth()
  }, [linkedLeftKey, persistWidth])

  const resizePanelWithKeyboard = useCallback((next: number) => {
    resizeSidePanelPair(link, findLinkedSidePanel(linkedLeftKey), next, window.innerWidth, true)
  }, [link, linkedLeftKey])

  return {
    panelWidth,
    viewportWidth,
    resizePanel,
    persistPanelWidth,
    resizePanelWithKeyboard,
  }
}
