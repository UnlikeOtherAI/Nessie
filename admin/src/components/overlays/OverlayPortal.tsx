import { useSyncExternalStore, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

/**
 * Every overlay leaves the page tree (docs/navigation/overview.md §7).
 *
 * The layer scale in `navigation/overlay.ts` only decides who wins *inside one
 * stacking context*. An overlay declared where it is used — a task dialog
 * inside the project board, a popover inside a sidebar row — inherits every
 * ancestor between it and the document, and any one of them can quietly take
 * the overlay's `position: fixed` away from the viewport (`transform`,
 * `filter`, `backdrop-filter`, `will-change`, `contain`) or trap its z-index
 * below the shell's own chrome (`isolation`, a positioned ancestor, an
 * `overflow: clip` clipper). The admin has all of those on the path a page
 * takes: `main` clips, `.phone-navigation-viewport` isolates, and
 * `.phone-navigation-screen` is an absolutely positioned, clipped layer that
 * carries a transform for the whole of a stack transition.
 *
 * When that happens the scrim stops being the screen: it covers the content
 * column only, so the rail and the secondary sidebar stay unblurred and paint
 * over the panel, and the panel itself is cut off at the sidebar's edge. The
 * layer number is right and the picture is wrong, which is exactly the kind of
 * bug prose cannot prevent — so no overlay renders where it is declared. Each
 * one portals into one host appended to `document.body`, where the only
 * stacking context is the root's and the only containing block is the
 * viewport.
 *
 * `active={false}` renders in place, for the one surface that is an overlay on
 * `split` and a real screen in the phone navigation stack on `single`
 * (`ChannelConversationComposePage`): a screen must travel with its layer.
 */

// React refuses to render a portal on the static renderer and says so:
// "render them conditionally so that they only appear on the client render".
// This is that condition, asked of React itself rather than sniffed off a
// global — `document` is installed and removed around individual cases in this
// package's suite, so `typeof document` answers differently depending on which
// file ran last. A few suites assert an overlay's markup with
// `renderToStaticMarkup`; there is no host and nothing painting over it there,
// so the tree renders in place.
const NEVER_CHANGES = () => () => undefined
const useIsStaticRender = (): boolean =>
  useSyncExternalStore(NEVER_CHANGES, () => false, () => true)

let host: HTMLElement | null = null

/**
 * The one host, created on first use and kept for the life of the document.
 * Several open overlays share it — they are ordered by the layer scale, not by
 * DOM position — so nothing has to reconcile a per-overlay container against
 * React's own commits.
 */
const overlayHost = (): HTMLElement | null => {
  if (typeof document === 'undefined') return null
  // Also the owning document, not just connectedness: this module outlives a
  // page in the test suite, where each file drives its own DOM, and a host
  // still connected to the previous one would take every portal with it.
  if (host?.isConnected && host.ownerDocument === document) return host
  host = document.createElement('div')
  host.className = 'admin-overlay-root'
  document.body.appendChild(host)
  return host
}

type OverlayPortalProps = {
  /** False keeps the tree where it is; see the note above. */
  active?: boolean
  children: ReactNode
}

export const OverlayPortal = ({ active = true, children }: OverlayPortalProps): ReactNode => {
  const staticRender = useIsStaticRender()
  if (!active || staticRender) return children
  // Resolved during render, not in an effect: `useOverlay` starts the open
  // motion in a layout effect on the panel it just rendered, so a host that
  // only arrived on a second commit would silently drop every overlay's
  // entrance. The call is idempotent, so a double render (StrictMode) and a
  // document whose body was replaced between tests both converge on one live
  // host rather than leaking a second.
  const resolved = overlayHost()
  if (!resolved) return children
  return createPortal(children, resolved)
}
