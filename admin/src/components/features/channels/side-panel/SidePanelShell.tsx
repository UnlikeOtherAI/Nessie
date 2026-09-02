import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react'

import { useResizeHandleReveal } from '../../../../hooks/useResizeHandleReveal'
import { useViewport } from '../../../../hooks/useViewport'
import { ColumnResizeHandle } from '../../../primitives/ColumnResizeHandle'
import { THREAD_PANEL_MIN_WIDTH } from '../thread-panel/thread-panel-helpers'

const KEYBOARD_RESIZE_STEP = 16

type SidePanelShellProps = {
  ariaLabel: string
  children: ReactNode
  /** Spread onto the aside — the reply panel drops attachments onto itself. */
  containerProps?: Record<string, unknown>
  isClosing: boolean
  onClose: () => void
  panelWidth: number
  persistPanelWidth: () => void
  resizePanel: (next: number) => void
  resizePanelWithKeyboard: (next: number) => void
  viewportWidth: number
}

/**
 * The right-hand panel frame: breakpoints, scrim, and the drag-resize
 * separator.
 *
 * Extracted from `ThreadReplyPanel` when the agent-screen panel arrived. Two
 * copies of this would drift on the parts nobody looks at twice — which
 * breakpoint owns the safe-area inset, whether a cancelled drag keeps the last
 * width, whether the body cursor is restored when a drag ends by window blur —
 * and each of those is a bug that only shows up on somebody else's device.
 *
 * Layout: pushes in flow at ≥1280px, floats over the conversation with a
 * scrim between 900 and 1279, and takes the whole screen below 900.
 */
export const SidePanelShell = ({
  ariaLabel,
  children,
  containerProps,
  isClosing,
  onClose,
  panelWidth,
  persistPanelWidth,
  resizePanel,
  resizePanelWithKeyboard,
  viewportWidth,
}: SidePanelShellProps) => {
  const [isResizing, setIsResizing] = useState(false)
  const { capabilities: { coarsePointer } } = useViewport()
  const {
    hideHandle,
    isHandleRevealed,
    revealHandle,
    scheduleHandleHide,
  } = useResizeHandleReveal(coarsePointer)
  const resizeCleanup = useRef<(() => void) | null>(null)
  useEffect(() => () => resizeCleanup.current?.(), [])

  const startResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return

    event.preventDefault()
    revealHandle()
    setIsResizing(true)
    const startX = event.clientX
    const startWidth = panelWidth
    let cancelled = false

    // Coalesce each burst of pointermoves into one resize per frame, and
    // write localStorage once at interaction end instead of per move.
    let frame: number | undefined
    let pendingClientX: number | null = null
    const flush = () => {
      frame = undefined
      if (pendingClientX === null) return
      const clientX = pendingClientX
      pendingClientX = null
      resizePanel(startWidth + (startX - clientX))
    }
    const move = (moveEvent: PointerEvent) => {
      pendingClientX = moveEvent.clientX
      if (frame === undefined) frame = requestAnimationFrame(flush)
    }
    // Runs for every termination — pointerup, pointercancel, window blur,
    // unmount mid-drag — so the body cursor/userSelect can never stick.
    // A cancel drops the pending frame and keeps the last applied width.
    const stop = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', stop)
      window.removeEventListener('pointercancel', cancel)
      window.removeEventListener('blur', cancel)
      if (frame !== undefined) cancelAnimationFrame(frame)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      if (!cancelled) flush()
      persistPanelWidth()
      setIsResizing(false)
      if (cancelled) hideHandle()
      else scheduleHandleHide()
      resizeCleanup.current = null
    }
    const cancel = () => {
      cancelled = true
      stop()
    }

    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', stop)
    window.addEventListener('pointercancel', cancel)
    window.addEventListener('blur', cancel)
    resizeCleanup.current = cancel
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
  }

  // The separator exposes an ARIA separator role, so it owes the same
  // keyboard path the sidebar separator has: arrows step, Home/End jump.
  const resizeWithKeyboard = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    let nextWidth: number | null = null
    if (event.key === 'ArrowLeft') nextWidth = panelWidth + KEYBOARD_RESIZE_STEP
    if (event.key === 'ArrowRight') nextWidth = panelWidth - KEYBOARD_RESIZE_STEP
    if (event.key === 'Home') nextWidth = viewportWidth / 2
    if (event.key === 'End') nextWidth = THREAD_PANEL_MIN_WIDTH
    if (nextWidth === null) return

    event.preventDefault()
    resizePanelWithKeyboard(nextWidth)
  }

  return (
    <>
      <button
        aria-label={`Close ${ariaLabel.toLowerCase()}`}
        className="thread-panel-scrim fixed inset-0 z-[var(--layer-card)] hidden bg-[var(--scrim-strong)] min-[900px]:max-xl:block"
        data-closing={isClosing ? 'true' : 'false'}
        onClick={onClose}
        type="button"
      />
      <aside
        aria-label={ariaLabel}
        className={[
          'thread-panel admin-chat-surface z-[var(--layer-popover)] flex w-full flex-col border-l border-[color:var(--sep)] bg-[color:var(--main)]',
          // The regular admin columns receive the status-bar inset from the
          // WebView bridge. This fixed overlay sits outside those columns, so
          // it owns the inset itself and keeps its header controls out from
          // under an iOS notch in both phone and tablet overlay modes.
          'max-[900px]:fixed max-[900px]:inset-0 max-xl:pt-[env(safe-area-inset-top,0px)]',
          'min-[900px]:w-[var(--thread-panel-width)]',
          'min-[900px]:max-xl:fixed min-[900px]:max-xl:inset-y-0 min-[900px]:max-xl:right-0',
          'min-[900px]:max-xl:shadow-[0_32px_80px_var(--scrim-strong)]',
          'xl:relative xl:z-auto xl:h-full xl:shrink-0',
        ].join(' ')}
        data-closing={isClosing ? 'true' : 'false'}
        style={{ '--thread-panel-width': `${panelWidth}px` } as CSSProperties}
        {...containerProps}
      >
        <div
          aria-label={`Resize ${ariaLabel.toLowerCase()}`}
          aria-orientation="vertical"
          aria-valuemax={Math.floor(Math.max(viewportWidth / 2, THREAD_PANEL_MIN_WIDTH))}
          aria-valuemin={THREAD_PANEL_MIN_WIDTH}
          aria-valuenow={panelWidth}
          className={[
            'column-resize-control thread-panel-resize-control absolute inset-y-0 z-[var(--layer-stack)] hidden touch-none xl:flex',
            isResizing ? 'is-resizing' : '',
            isHandleRevealed ? 'is-revealed' : '',
          ].join(' ')}
          onBlur={() => !isResizing && hideHandle()}
          onFocus={revealHandle}
          onKeyDown={resizeWithKeyboard}
          onPointerDown={startResize}
          onPointerEnter={revealHandle}
          onPointerLeave={() => !isResizing && !coarsePointer && hideHandle()}
          role="separator"
          tabIndex={0}
        >
          <ColumnResizeHandle />
        </div>
        {children}
      </aside>
    </>
  )
}
