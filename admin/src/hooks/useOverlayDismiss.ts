import { useCallback, useRef, type MouseEvent } from 'react'

type OverlayDismissProps = {
  onMouseDown: (event: MouseEvent<HTMLDivElement>) => void
  onMouseUp: (event: MouseEvent<HTMLDivElement>) => void
  role: 'presentation'
}

/**
 * Click-outside-to-dismiss for a modal scrim, spread onto the overlay element.
 *
 * The obvious implementation — `onClick` plus `event.target === event.currentTarget`
 * — dismisses the dialog when a drag *ends* on the scrim, even though it began
 * inside the panel. Selecting the text in a rename field and releasing the mouse
 * a few pixels outside the panel therefore threw the dialog away mid-edit: the
 * browser dispatches `click` on the nearest common ancestor of the press and the
 * release, which for that gesture is the overlay itself.
 *
 * So the gesture is judged by both of its ends: dismiss only when the press and
 * the release both landed on the scrim. Escape and the panel's own close control
 * remain the deliberate ways out, and live in `useModalA11y`.
 */
export const useOverlayDismiss = (onDismiss: () => void): OverlayDismissProps => {
  const pressedOnOverlay = useRef(false)

  const onMouseDown = useCallback((event: MouseEvent<HTMLDivElement>) => {
    pressedOnOverlay.current = event.target === event.currentTarget
  }, [])

  const onMouseUp = useCallback(
    (event: MouseEvent<HTMLDivElement>) => {
      const releasedOnOverlay = event.target === event.currentTarget
      const shouldDismiss = pressedOnOverlay.current && releasedOnOverlay
      pressedOnOverlay.current = false
      if (shouldDismiss) {
        onDismiss()
      }
    },
    [onDismiss],
  )

  return { onMouseDown, onMouseUp, role: 'presentation' }
}
