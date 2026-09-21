import { createContext, useCallback, useContext, useSyncExternalStore, type ReactNode } from 'react'

/**
 * Which navigation-stack layer an overlay was opened from, so it can follow
 * that layer (docs/navigation/overlays.md, "An overlay belongs to its layer").
 *
 * Every overlay portals to `document.body` to escape the page's stacking
 * contexts — which also takes it out of the layer that hides a covered screen.
 * The stack keeps a covered screen mounted (inert, aria-hidden, or `hidden`
 * when deeper), and its URL keeps whatever opened the overlay, so a ticket
 * dialog opened on the board stayed painted, focus-trapped and first in line
 * for Back over the board settings pushed on top of it.
 *
 * So the layer says where it is in the DOM, and the overlay watches it: while
 * the element (or the stack screen around it) is `hidden` or `inert`, the
 * overlay is covered — not painted, not trapping focus, not registered for
 * Back — and it comes back as it was when its layer is on top again. The
 * provider is `PhoneNavigationLayer` for a route's layer and `NestedStage` for
 * a stage, whose children are portalled from the page's React position and
 * would otherwise read the route layer beneath them. Where no stack hosts the
 * screen, nothing provides it and an overlay is never covered.
 */
type LayerElementGetter = () => HTMLElement | null

const OverlayLayerContext = createContext<LayerElementGetter | null>(null)

export const OverlayLayerProvider = ({
  children,
  element,
}: {
  children: ReactNode
  element: LayerElementGetter
}) => <OverlayLayerContext.Provider value={element}>{children}</OverlayLayerContext.Provider>

const LAYER_SELECTOR = '[data-phone-navigation-route]'

const layerScreenOf = (element: HTMLElement | null): HTMLElement | null =>
  element?.closest<HTMLElement>(LAYER_SELECTOR) ?? null

/** Covered: the layer's own element or its stack screen is hidden or inert. */
export const isLayerCovered = (element: HTMLElement | null): boolean => {
  if (!element?.isConnected) return false
  const screen = layerScreenOf(element)
  return [element, screen].some((node) => node !== null && (node.hidden || node.hasAttribute('inert')))
}

const NEVER_COVERED = () => () => undefined

export const useOverlayLayerCovered = (): boolean => {
  const getElement = useContext(OverlayLayerContext)
  const subscribe = useCallback(
    (onChange: () => void) => {
      if (!getElement || typeof MutationObserver === 'undefined') return () => undefined
      const observer = new MutationObserver(onChange)
      let watched: HTMLElement | null = null
      const watch = () => {
        const element = getElement()
        const screen = layerScreenOf(element) ?? element
        if (!screen || screen === watched) return
        observer.disconnect()
        watched = screen
        // The screen's own attributes, and its subtree for a stage container
        // that is moved into (or out of) a layer after it first rendered.
        observer.observe(screen, { attributeFilter: ['hidden', 'inert'], attributes: true, subtree: true })
      }
      watch()
      // A stage container reaches its layer after the first commit.
      const frame = typeof requestAnimationFrame === 'function'
        ? requestAnimationFrame(() => { watch(); onChange() })
        : null
      return () => {
        if (frame !== null) cancelAnimationFrame(frame)
        observer.disconnect()
      }
    },
    [getElement],
  )
  return useSyncExternalStore(
    getElement ? subscribe : NEVER_COVERED,
    () => (getElement ? isLayerCovered(getElement()) : false),
    () => false,
  )
}
