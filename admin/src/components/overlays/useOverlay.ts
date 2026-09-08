import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import { holdNativeChromeSuspended } from '../../navigation/full-bleed-layers'
import { useLocalBack } from '../../navigation/LocalBackContext'
import { useNavigationLayout } from '../../navigation/mobile-shell'
import {
  OVERLAY_BACK_PRIORITY,
  OVERLAY_LAYER,
  runOverlayTransition,
  type OverlayKind,
  type SheetSide,
} from '../../navigation/overlay'
import { useReducedMotion } from '../../navigation/reduced-motion'
import { useModalA11y } from '../../hooks/useModalA11y'
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
}

export type OverlayState = {
  // True while open, and while the close motion plays out.
  mounted: boolean
  closing: boolean
  panelRef: RefObject<HTMLDivElement | null>
  layerStyle: { zIndex: string }
  requestClose: () => void
  scrimProps: ReturnType<typeof useOverlayDismiss>
}

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
}: UseOverlayOptions): OverlayState => {
  const panelRef = useRef<HTMLDivElement | null>(null)
  const reducedMotion = useReducedMotion()
  const layout = useNavigationLayout()
  const [closing, setClosing] = useState(false)
  const effectiveKind = kind === 'popover' && ownerKind === 'modal' ? 'modalPopover' : kind

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
    active: open && (kind !== 'popover' || ownerKind === 'modal' || layout === 'single'),
    id: `overlay:${id}`,
    label,
    onBack: requestClose,
    priority: OVERLAY_BACK_PRIORITY[effectiveKind],
  })

  // A modal covers the document, so any native chrome placed over the page
  // beneath it is pointing at something the reader can no longer see.
  useEffect(() => {
    if (!open || kind !== 'modal') return undefined
    return holdNativeChromeSuspended()
  }, [kind, open])

  const trapsFocus = kind !== 'popover'
  useModalA11y(panelRef, requestClose, open && trapsFocus, initialFocusRef)
  useEffect(() => {
    if (!open || trapsFocus) return undefined
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      if (ownerKind === 'modal') {
        const target = event.target
        const inMenu = target instanceof Node && panelRef.current?.contains(target)
        const onAnchor = target instanceof Node && escapeAnchorRef?.current?.contains(target)
        if (!inMenu && !onAnchor) return
      }
      event.preventDefault()
      event.stopPropagation()
      requestClose()
    }
    // A portalled popover can be owned by a modal while focus remains on its
    // trigger inside that modal. Capture closes that focused menu before the
    // modal's focus trap sees Escape; a blocking panel owns focus, so it wins.
    document.addEventListener('keydown', onKeyDown, ownerKind === 'modal')
    return () => document.removeEventListener('keydown', onKeyDown, ownerKind === 'modal')
  }, [escapeAnchorRef, open, ownerKind, requestClose, trapsFocus])

  const scrimProps = useOverlayDismiss(requestClose)

  // Open motion on the panel once it is in the DOM.
  useLayoutEffect(() => {
    if (!open) return undefined
    const run = runOverlayTransition({
      direction: 'open',
      element: panelRef.current,
      kind: effectiveKind,
      reducedMotion,
      side,
    })
    return () => run.cancel()
  }, [effectiveKind, open, reducedMotion, side])

  // Close motion: the element stays mounted, inert, until it has played out.
  const wasOpen = useRef(open)
  useLayoutEffect(() => {
    const closedNow = wasOpen.current && !open
    wasOpen.current = open
    if (!closedNow) return undefined
    const element = panelRef.current
    if (!element) return undefined
    setClosing(true)
    const run = runOverlayTransition({ direction: 'close', element, kind: effectiveKind, reducedMotion, side })
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
    layerStyle: { zIndex: `var(--layer-${effectiveKind.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}, ${OVERLAY_LAYER[effectiveKind]})` },
    mounted: open || closing,
    panelRef,
    requestClose,
    scrimProps,
  }
}
