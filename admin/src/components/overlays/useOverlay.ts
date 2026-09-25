import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import { holdNativeChromeSuspended } from '../../navigation/full-bleed-layers'
import { useLocalBack } from '../../navigation/LocalBackContext'
import { useNavigationLayout } from '../../navigation/mobile-shell'
import { useOverlayLayerCovered } from '../../navigation/overlay-layer'
import {
  OVERLAY_BACK_PRIORITY,
  OVERLAY_LAYER,
  runOverlayTransition,
  type OverlayKind,
  type OverlayRevealOrigin,
  type SheetSide,
} from '../../navigation/overlay'
import { useReducedMotion } from '../../navigation/reduced-motion'
import { useModalA11y } from '../../hooks/useModalA11y'
import { useFocusedOverlayControl } from '../../hooks/useFocusedOverlayControl'
import { useOverlayDismiss } from '../../hooks/useOverlayDismiss'

// The shared work every overlay does once (docs/navigation/overview.md §7): the Back
// registration while open, Escape and the focus trap (modal, sheet and the
// sanctioned blocking nesting; a popover gets Escape only), the drag-safe
// scrim dismiss, the layer, and the open/close motion on the kind's token —
// reduced motion at 0 ms through the same path. A primitive composes this;
// nothing composes useModalA11y or useOverlayDismiss on its own.

export type UseOverlayOptions = {
  id: string
  kind: Exclude<OverlayKind, 'card'>
  // What the Back control announces while this overlay is on top.
  label: string
  open: boolean
  onClose: () => void
  // Refuses every close path the overlay owns while a submit is in flight.
  dismissDisabled?: boolean
  // An anchored popover owned by a modal remains above and closes before that
  // modal, while still yielding to a blocking overlay.
  ownerKind?: 'modal'
  escapeAnchorRef?: RefObject<HTMLElement | null>
  initialFocusRef?: RefObject<HTMLElement | null>
  side?: SheetSide
  motionReady?: boolean
  revealOrigin?: OverlayRevealOrigin | null
}

export type OverlayState = {
  // True while open, and while the close motion plays out.
  mounted: boolean
  closing: boolean
  // Open, but its screen is covered by one pushed over it (see above).
  covered: boolean
  panelRef: RefObject<HTMLDivElement | null>
  layerStyle: { zIndex: string }
  requestClose: () => void
  scrimProps: ReturnType<typeof useOverlayDismiss>
}

// Same-layer submenus dismiss from the top down. A document-level listener
// per popover otherwise lets one Escape close every open ancestor at once.
const popoverEscapes = new Set<{ document: Document; layer: number }>()
const handledPopoverEscapes = new WeakSet<KeyboardEvent>()

export const useOverlay = ({
  id,
  kind,
  label,
  open,
  onClose,
  dismissDisabled = false,
  ownerKind,
  escapeAnchorRef,
  initialFocusRef,
  side,
  motionReady = true,
  revealOrigin,
}: UseOverlayOptions): OverlayState => {
  const panelRef = useRef<HTMLDivElement | null>(null)
  const revealOriginRef = useRef<OverlayRevealOrigin | null>(null)
  if (revealOrigin) revealOriginRef.current = revealOrigin
  const reducedMotion = useReducedMotion()
  const layout = useNavigationLayout()
  const [closing, setClosing] = useState(false)
  const effectiveKind = kind === 'popover' && ownerKind === 'modal' ? 'modalPopover' : kind
  // Opened from a screen something is now pushed over: the overlay stays
  // mounted (its state and draft survive) but is dormant — no Back, no focus
  // trap, no Escape, no native-chrome hold — until its screen is on top again.
  // OverlayPortal hides it through the same hook.
  const covered = useOverlayLayerCovered()
  const live = open && !covered

  // The live handler and the live dismiss gate ride in refs so the callback
  // handed to the a11y hook stays stable: call sites rebuild `onClose` on
  // every keystroke, and re-running that effect would yank focus back to the
  // first field. Synced during render, not in an effect, so a close gesture
  // landing between a commit and an effect cannot read a stale gate.
  const onCloseRef = useRef(onClose)
  const dismissDisabledRef = useRef(dismissDisabled)
  onCloseRef.current = onClose
  dismissDisabledRef.current = dismissDisabled

  const requestClose = useCallback(() => {
    if (dismissDisabledRef.current) return
    onCloseRef.current()
  }, [])

  // Hardware Back, the header Back and the edge swipe close the overlay
  // before any route change. A modal-owned popover stays above its owner on
  // every layout; an ordinary popover owns Back on a single column only.
  useLocalBack({
    active: live && (kind !== 'popover' || ownerKind === 'modal' || layout === 'single'),
    id: `overlay:${id}`,
    label,
    onBack: requestClose,
    priority: OVERLAY_BACK_PRIORITY[effectiveKind],
  })

  // A modal covers the document, so any native chrome placed over the page
  // beneath it is pointing at something the reader can no longer see.
  useEffect(() => {
    if (!live || kind !== 'modal') return undefined
    return holdNativeChromeSuspended()
  }, [kind, live])

  const trapsFocus = kind !== 'popover'
  useModalA11y(panelRef, requestClose, live && trapsFocus, initialFocusRef)
  // A field in any modal or sheet stays above the keyboard. Popovers do not
  // trap focus and place themselves through their own bounded geometry.
  useFocusedOverlayControl(panelRef, live && trapsFocus)
  useEffect(() => {
    if (!live || trapsFocus) return undefined
    const registration = { document, layer: OVERLAY_LAYER[effectiveKind] }
    popoverEscapes.add(registration)
    const onKeyDown = (event: KeyboardEvent) => {
      // A row may prevent Escape's default while focus is returning from a
      // previous menu. Only another overlay's claim makes this key consumed.
      if (event.key !== 'Escape' || handledPopoverEscapes.has(event)) return
      const top = [...popoverEscapes].filter((entry) => entry.document === document)
        .reduce((highest, entry) => entry.layer >= highest.layer ? entry : highest, registration)
      if (top !== registration) return
      if (ownerKind === 'modal') {
        const target = event.target
        const panel = panelRef.current
        const domNode = panel?.ownerDocument.defaultView?.Node
        if (!panel || !domNode || !(target instanceof domNode)) return
        const inMenu = panel.contains(target)
        const onAnchor = escapeAnchorRef?.current?.contains(target)
        if (!inMenu && !onAnchor) return
      }
      handledPopoverEscapes.add(event)
      event.preventDefault()
      event.stopPropagation()
      escapeAnchorRef?.current?.focus()
      requestClose()
    }
    // A portalled popover can be owned by a modal while focus remains on its
    // trigger inside that modal. Capture closes that focused menu before the
    // modal's focus trap sees Escape; a blocking panel owns focus, so it wins.
    document.addEventListener('keydown', onKeyDown, ownerKind === 'modal')
    return () => {
      popoverEscapes.delete(registration)
      document.removeEventListener('keydown', onKeyDown, ownerKind === 'modal')
    }
  }, [effectiveKind, escapeAnchorRef, live, ownerKind, requestClose, trapsFocus])

  const scrimProps = useOverlayDismiss(requestClose)

  // Open motion on the panel once it is in the DOM.
  useLayoutEffect(() => {
    if (!open || !motionReady) return undefined
    const run = runOverlayTransition({
      direction: 'open',
      element: panelRef.current,
      kind: effectiveKind,
      reducedMotion,
      side,
      revealOrigin: revealOriginRef.current,
    })
    return () => run.cancel()
  }, [effectiveKind, motionReady, open, reducedMotion, side])

  // Close motion: the element stays mounted, inert, until it has played out.
  const wasOpen = useRef(open)
  useLayoutEffect(() => {
    const closedNow = wasOpen.current && !open
    wasOpen.current = open
    if (!closedNow) return undefined
    const element = panelRef.current
    if (!element) return undefined
    setClosing(true)
    const run = runOverlayTransition({
      direction: 'close', element, kind: effectiveKind, reducedMotion, side,
      revealOrigin: revealOriginRef.current,
    })
    let cancelled = false
    void run.finished.then(() => {
      if (!cancelled) setClosing(false)
    })
    return () => {
      cancelled = true
      run.cancel()
      setClosing(false)
    }
  }, [effectiveKind, open, reducedMotion, side])

  return {
    closing,
    covered,
    layerStyle: { zIndex: `var(--layer-${effectiveKind.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}, ${OVERLAY_LAYER[effectiveKind]})` },
    mounted: open || closing,
    panelRef,
    requestClose,
    scrimProps,
  }
}
