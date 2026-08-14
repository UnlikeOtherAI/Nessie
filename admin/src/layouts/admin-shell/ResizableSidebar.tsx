import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { getCookie, setCookie } from '../../lib/storage'

const SIDEBAR_WIDTH_COOKIE = 'sidebarWidthPercent'
const DEFAULT_SIDEBAR_WIDTH_PX = 260
const MIN_SIDEBAR_WIDTH_PX = 200
const MAX_SIDEBAR_WIDTH_PERCENT = 35
const KEYBOARD_STEP_PERCENT = 1

type ResizableSidebarProps = {
  children: ReactNode
  fixed?: boolean
}

const clamp = (value: number, minimum: number, maximum: number): number =>
  Math.min(Math.max(value, minimum), maximum)

export const minimumSidebarWidthPercent = (viewportWidth: number): number =>
  (MIN_SIDEBAR_WIDTH_PX / viewportWidth) * 100

export const clampSidebarWidthPercent = (
  widthPercent: number,
  viewportWidth: number,
): number =>
  clamp(
    widthPercent,
    minimumSidebarWidthPercent(viewportWidth),
    MAX_SIDEBAR_WIDTH_PERCENT,
  )

export const parseStoredSidebarWidthPercent = (storedValue: string | null): number | null => {
  if (storedValue === null) return null

  const value = Number(storedValue)
  return Number.isFinite(value) ? value : null
}

const readStoredSidebarWidthPercent = (): number | null =>
  parseStoredSidebarWidthPercent(getCookie(SIDEBAR_WIDTH_COOKIE))

const initialSidebarWidthPercent = (): number => {
  const viewportWidth = window.innerWidth
  const storedWidth = readStoredSidebarWidthPercent()
  const defaultWidth = (DEFAULT_SIDEBAR_WIDTH_PX / viewportWidth) * 100

  return clampSidebarWidthPercent(storedWidth ?? defaultWidth, viewportWidth)
}

/**
 * Owns the width of the desktop/tablet secondary navigation. The persisted
 * value is deliberately viewport-relative so a device resize retains the
 * proportion a person chose, rather than a stale pixel width.
 */
export const ResizableSidebar = ({ children, fixed = false }: ResizableSidebarProps) => {
  const sidebarRef = useRef<HTMLDivElement>(null)
  const [isResizing, setIsResizing] = useState(false)
  const [isHandleRevealed, setIsHandleRevealed] = useState(false)
  const [widthPercent, setWidthPercent] = useState(initialSidebarWidthPercent)
  // Continuous geometry is allowlisted from the useViewport band store (the
  // plan's §C.5): the percent minimum changes continuously with width, so a
  // breakpoint subscription cannot recompute it.
  const [viewportWidth, setViewportWidth] = useState(() => window.innerWidth)

  // Keep the preferred width, and therefore the announced aria-valuenow,
  // inside the current allowed range when the viewport changes the limits
  // (CSS clamps the rendered track; without this the state and its ARIA
  // mirror are the stale values). A shrink/grow re-clamps but never rewrites
  // the cookie — the persisted preference survives a temporary resize.
  useEffect(() => {
    const onResize = () => {
      const nextViewportWidth = window.innerWidth
      setViewportWidth(nextViewportWidth)
      setWidthPercent((current) => clampSidebarWidthPercent(current, nextViewportWidth))
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  // Applies one drag position. Frame-coalesced by startResize and released
  // from the persist effect below so the drag itself only moves state.
  const setSidebarWidthFromClientX = useCallback((clientX: number) => {
    const sidebarLeft = sidebarRef.current?.getBoundingClientRect().left ?? 0
    const nextWidth = ((clientX - sidebarLeft) / window.innerWidth) * 100
    setWidthPercent(clampSidebarWidthPercent(nextWidth, window.innerWidth))
  }, [])

  // Persist once, at interaction end: the drag moves state per frame, and
  // the cookie write happens when (and only when) the gesture finishes.
  useEffect(() => {
    if (!isResizing) {
      setCookie(SIDEBAR_WIDTH_COOKIE, String(widthPercent))
    }
  }, [isResizing, widthPercent])

  // Tears down a captured drag's pending frame if the component unmounts or
  // the gesture is cancelled mid-drag, so no stale frame writes afterwards.
  const dragCleanup = useRef<(() => void) | null>(null)
  useEffect(() => () => dragCleanup.current?.(), [])

  const startResize = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) return

      event.preventDefault()
      event.currentTarget.setPointerCapture(event.pointerId)
      setIsHandleRevealed(true)
      setIsResizing(true)

      // Coalesce every burst of pointermoves into at most one state update
      // per animation frame.
      let frame: number | undefined
      let pendingClientX: number | null = null
      const flush = () => {
        frame = undefined
        if (pendingClientX === null) return
        const clientX = pendingClientX
        pendingClientX = null
        setSidebarWidthFromClientX(clientX)
      }
      const onMove = (moveEvent: globalThis.PointerEvent) => {
        if (moveEvent.pointerId !== event.pointerId) return
        pendingClientX = moveEvent.clientX
        if (frame === undefined) frame = requestAnimationFrame(flush)
      }
      const cleanup = () => {
        if (frame !== undefined) cancelAnimationFrame(frame)
        frame = undefined
        pendingClientX = null
        window.removeEventListener('pointermove', onMove)
        window.removeEventListener('blur', cancelDrag)
        dragCleanup.current = null
      }
      const finishDrag = (upEvent: globalThis.PointerEvent) => {
        if (upEvent.pointerId !== event.pointerId) return
        cleanup()
        setIsResizing(false)
      }
      // pointercancel and window blur end the gesture without a final move:
      // state keeps the last applied frame and the persist-on-end effect
      // stores exactly what is on screen.
      const cancelDrag = () => {
        cleanup()
        setIsResizing(false)
      }
      dragCleanup.current = cancelDrag
      const target = event.currentTarget
      window.addEventListener('pointermove', onMove)
      window.addEventListener('blur', cancelDrag)
      target.addEventListener('pointerup', finishDrag, { once: true })
      target.addEventListener('pointercancel', cancelDrag, { once: true })

      setSidebarWidthFromClientX(event.clientX)
    },
    [setSidebarWidthFromClientX],
  )

  const resizeWithKeyboard = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      const minimum = minimumSidebarWidthPercent(viewportWidth)
      let nextWidth: number | null = null

      if (event.key === 'ArrowLeft') nextWidth = widthPercent - KEYBOARD_STEP_PERCENT
      if (event.key === 'ArrowRight') nextWidth = widthPercent + KEYBOARD_STEP_PERCENT
      if (event.key === 'Home') nextWidth = minimum
      if (event.key === 'End') nextWidth = MAX_SIDEBAR_WIDTH_PERCENT
      if (nextWidth === null) return

      event.preventDefault()
      const nextWidthPercent = clampSidebarWidthPercent(nextWidth, viewportWidth)
      setWidthPercent(nextWidthPercent)
      setCookie(SIDEBAR_WIDTH_COOKIE, String(nextWidthPercent))
    },
    [viewportWidth, widthPercent],
  )

  return (
    <div
      className={fixed ? 'resizable-sidebar fixed-sidebar' : 'resizable-sidebar'}
      ref={sidebarRef}
      style={{
        flexBasis: fixed
          ? `${DEFAULT_SIDEBAR_WIDTH_PX}px`
          : `clamp(${MIN_SIDEBAR_WIDTH_PX}px, ${widthPercent}vw, ${MAX_SIDEBAR_WIDTH_PERCENT}vw)`,
      }}
    >
      {children}
      {!fixed ? (
        <div
          aria-label="Resize sidebar"
          aria-orientation="vertical"
          aria-valuemax={MAX_SIDEBAR_WIDTH_PERCENT}
          aria-valuemin={Math.ceil(minimumSidebarWidthPercent(viewportWidth))}
          aria-valuenow={Math.round(widthPercent)}
          className={[
            'resizable-sidebar-control',
            isResizing ? 'is-resizing' : '',
            isHandleRevealed ? 'is-revealed' : '',
          ].filter(Boolean).join(' ')}
          onBlur={() => !isResizing && setIsHandleRevealed(false)}
          onFocus={() => setIsHandleRevealed(true)}
          onKeyDown={resizeWithKeyboard}
          onPointerDown={startResize}
          onPointerEnter={() => setIsHandleRevealed(true)}
          onPointerLeave={() => !isResizing && setIsHandleRevealed(false)}
          role="separator"
          tabIndex={0}
        >
          <span aria-hidden="true" className="resizable-sidebar-handle">
            <span />
            <span />
            <span />
          </span>
        </div>
      ) : null}
    </div>
  )
}
