import { useCallback, useRef, useState, type ReactNode } from 'react'
import { getCookie, setCookie } from '../../lib/storage'

const SIDEBAR_WIDTH_COOKIE = 'sidebarWidthPercent'
const DEFAULT_SIDEBAR_WIDTH_PX = 260
const MIN_SIDEBAR_WIDTH_PX = 200
const MAX_SIDEBAR_WIDTH_PERCENT = 35
const KEYBOARD_STEP_PERCENT = 1

type ResizableSidebarProps = {
  children: ReactNode
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
export const ResizableSidebar = ({ children }: ResizableSidebarProps) => {
  const sidebarRef = useRef<HTMLDivElement>(null)
  const [isResizing, setIsResizing] = useState(false)
  const [isHandleRevealed, setIsHandleRevealed] = useState(false)
  const [widthPercent, setWidthPercent] = useState(initialSidebarWidthPercent)

  const setSidebarWidthFromClientX = useCallback((clientX: number) => {
    const sidebarLeft = sidebarRef.current?.getBoundingClientRect().left ?? 0
    const nextWidth = ((clientX - sidebarLeft) / window.innerWidth) * 100
    const nextWidthPercent = clampSidebarWidthPercent(nextWidth, window.innerWidth)

    setWidthPercent(nextWidthPercent)
    setCookie(SIDEBAR_WIDTH_COOKIE, String(nextWidthPercent))
  }, [])

  const finishResize = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    setIsResizing(false)
  }, [])

  const startResize = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) return

      event.preventDefault()
      event.currentTarget.setPointerCapture(event.pointerId)
      setIsHandleRevealed(true)
      setIsResizing(true)
      setSidebarWidthFromClientX(event.clientX)
    },
    [setSidebarWidthFromClientX],
  )

  const resizeWithKeyboard = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      const viewportWidth = window.innerWidth
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
    [widthPercent],
  )

  return (
    <div
      className="resizable-sidebar"
      ref={sidebarRef}
      style={{ flexBasis: `clamp(${MIN_SIDEBAR_WIDTH_PX}px, ${widthPercent}vw, ${MAX_SIDEBAR_WIDTH_PERCENT}vw)` }}
    >
      {children}
      <div
        aria-label="Resize sidebar"
        aria-orientation="vertical"
        aria-valuemax={MAX_SIDEBAR_WIDTH_PERCENT}
        aria-valuemin={Math.ceil(minimumSidebarWidthPercent(window.innerWidth))}
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
        onPointerMove={(event) => isResizing && setSidebarWidthFromClientX(event.clientX)}
        onPointerCancel={finishResize}
        onPointerUp={finishResize}
        role="separator"
        tabIndex={0}
      >
        <span aria-hidden="true" className="resizable-sidebar-handle">
          <span />
          <span />
          <span />
        </span>
      </div>
    </div>
  )
}
