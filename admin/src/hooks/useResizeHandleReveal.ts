import { useCallback, useEffect, useRef, useState } from 'react'

export const RESIZE_HANDLE_AUTO_HIDE_MS = 4_000

// Coarse-pointer devices do not have a persistent hover state. Reveal the
// resize pill after a touch interaction, then put it away so it does not sit
// over the conversation indefinitely. Keyboard focus remains explicit and is
// therefore managed by the owning separator's blur handler.
export const useResizeHandleReveal = (coarsePointer: boolean) => {
  const [isHandleRevealed, setIsHandleRevealed] = useState(false)
  const hideTimeout = useRef<number | null>(null)

  const cancelHandleHide = useCallback(() => {
    if (hideTimeout.current === null) return
    window.clearTimeout(hideTimeout.current)
    hideTimeout.current = null
  }, [])

  const hideHandle = useCallback(() => {
    cancelHandleHide()
    setIsHandleRevealed(false)
  }, [cancelHandleHide])

  const revealHandle = useCallback(() => {
    cancelHandleHide()
    setIsHandleRevealed(true)
  }, [cancelHandleHide])

  const scheduleHandleHide = useCallback(() => {
    cancelHandleHide()
    if (!coarsePointer) return

    hideTimeout.current = window.setTimeout(() => {
      hideTimeout.current = null
      setIsHandleRevealed(false)
    }, RESIZE_HANDLE_AUTO_HIDE_MS)
  }, [cancelHandleHide, coarsePointer])

  useEffect(() => cancelHandleHide, [cancelHandleHide])

  return {
    hideHandle,
    isHandleRevealed,
    revealHandle,
    scheduleHandleHide,
  }
}
