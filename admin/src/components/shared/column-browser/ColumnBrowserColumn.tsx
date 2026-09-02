import { useEffect, useRef, type PointerEvent, type ReactNode } from 'react'
import { useScrollMemory } from '../../../hooks/useScrollMemory'
import { usePhoneLayout } from '../../../lib/mobile-shell'
import { PhoneBackButton } from '../../../layouts/admin-shell/PhoneBackButton'
import { PhoneNavigationButton } from '../../../layouts/admin-shell/PhoneNavigationButton'
import {
  columnBackPriority,
  useColumnBackContext,
  useLocalBack,
} from '../../../layouts/admin-shell/local-back/LocalBackContext'

// A keyboard step for the resize handle below — arbitrary but matches the
// step every other pixel-resizable surface in the admin uses.
const RESIZE_STEP = 24

export type ColumnResizeConfig = {
  width: number
  min: number
  max: number
  /**
   * Called on every width change. `commit` is false for in-progress pointer
   * drag frames (cheap, may fire many times a second) and true for a
   * complete interaction — a keypress, or the pointer released — the moment
   * a caller should persist the width. Never call `onResize` at all when the
   * caller doesn't want resizing; the handle only renders when this whole
   * config is present.
   */
  onResize: (width: number, commit: boolean) => void
}

// A draggable + keyboard-operable divider pinned to the column's own trailing
// edge, centred on its `border-r`. Dragging (pointer) or arrow keys adjust the
// width; touch-none keeps the drag from being stolen by the browser's scroll
// gesture on touch devices.
const ColumnResizeHandle = ({ max, min, onResize, width }: ColumnResizeConfig) => {
  // Tears down an in-progress drag's window listeners + body styles if the
  // column unmounts mid-drag (e.g. the browser opens/closes a deeper column).
  const cleanup = useRef<(() => void) | null>(null)
  useEffect(() => () => cleanup.current?.(), [])

  const clamp = (value: number): number => Math.min(max, Math.max(min, value))

  const startResize = (event: PointerEvent<HTMLDivElement>) => {
    event.preventDefault()
    const startX = event.clientX
    const startWidth = width
    let lastWidth = startWidth
    let cancelled = false

    // Coalesce each burst of pointermoves into one width update per frame.
    let frame: number | undefined
    let pendingClientX: number | null = null
    const flush = () => {
      frame = undefined
      if (pendingClientX === null) return
      const clientX = pendingClientX
      pendingClientX = null
      lastWidth = clamp(startWidth + (clientX - startX))
      onResize(lastWidth, false)
    }
    const move = (moveEvent: globalThis.PointerEvent) => {
      pendingClientX = moveEvent.clientX
      if (frame === undefined) frame = requestAnimationFrame(flush)
    }
    // Runs for every termination — pointerup, pointercancel, window blur,
    // unmount mid-drag — so the body cursor/userSelect can never stick.
    const stop = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', stop)
      window.removeEventListener('pointercancel', cancel)
      window.removeEventListener('blur', cancel)
      if (frame !== undefined) cancelAnimationFrame(frame)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      if (!cancelled) flush()
      onResize(lastWidth, true)
      cleanup.current = null
    }
    const cancel = () => {
      cancelled = true
      stop()
    }

    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', stop)
    window.addEventListener('pointercancel', cancel)
    window.addEventListener('blur', cancel)
    cleanup.current = cancel
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
  }

  return (
    <div
      aria-label="Resize column"
      aria-orientation="vertical"
      aria-valuemax={max}
      aria-valuemin={min}
      aria-valuenow={width}
      className="group absolute right-0 top-0 z-10 flex h-full w-4 translate-x-1/2 cursor-col-resize touch-none items-center justify-center focus:outline-none"
      onKeyDown={(event) => {
        if (event.key === 'ArrowLeft') {
          event.preventDefault()
          onResize(clamp(width - RESIZE_STEP), true)
        } else if (event.key === 'ArrowRight') {
          event.preventDefault()
          onResize(clamp(width + RESIZE_STEP), true)
        } else if (event.key === 'Home') {
          event.preventDefault()
          onResize(min, true)
        } else if (event.key === 'End') {
          event.preventDefault()
          onResize(max, true)
        }
      }}
      onPointerDown={startResize}
      role="separator"
      tabIndex={0}
    >
      <div className="h-full w-px bg-[color:var(--sep)] transition-colors group-hover:bg-[color:var(--accent)] group-focus:w-0.5 group-focus:bg-[color:var(--accent)]" />
    </div>
  )
}

type ColumnBrowserColumnProps = {
  children: ReactNode
  headerAction?: ReactNode
  leading?: ReactNode
  onBack?: () => void
  /**
   * Renders a drag/keyboard-resizable handle on the column's trailing edge.
   * The column itself never owns the width — `ColumnBrowserViewport`'s own
   * `columnWidth` prop does, so the two stay in sync — this only draws the
   * affordance and reports the caller's intended next width.
   */
  resize?: ColumnResizeConfig
  // True when this column owns a Back action at all — independent of layout.
  // Wider layouts paint the shared circular Back beside the title; on a phone
  // the column instead registers its unwind action with the shell's local-back
  // registry, and only the viewport-visible column's registration is active
  // (retained off-screen columns stay mounted for the slide transition but
  // must never hold the doorway). Deeper columns outrank shallower ones via
  // their viewport index, so Back always unwinds exactly one level.
  showBack?: boolean
  title: string
  // When set, the column's scroll position is remembered under this key and
  // restored when the column remounts (e.g. after leaving and returning to the
  // section's tab). Must be stable and unique per scroll region.
  scrollKey?: string
}

export const ColumnBrowserColumn = ({
  children,
  headerAction,
  leading,
  onBack,
  resize,
  showBack,
  title,
  scrollKey,
}: ColumnBrowserColumnProps) => {
  const phoneLayout = usePhoneLayout()
  const scroll = useScrollMemory(scrollKey)
  const { index, phoneVisible } = useColumnBackContext()
  const backLabel = `Back from ${title}`
  useLocalBack({
    active: phoneLayout && phoneVisible && Boolean(showBack && onBack),
    id: `column:${index ?? 'standalone'}:${title}`,
    label: backLabel,
    onBack: onBack ?? (() => undefined),
    priority: columnBackPriority(index ?? 0),
  })

  return (
    <div className="relative flex h-full flex-col border-r border-[color:var(--sep)] bg-[color:var(--main)]">
      <div className="flex h-[50px] flex-shrink-0 items-center gap-2 border-b border-[color:var(--sep)] px-4">
        {leading}
        {showBack && onBack
          ? phoneLayout
            ? phoneVisible
              ? <PhoneNavigationButton />
              : null
            : <PhoneBackButton label={backLabel} onBack={onBack} />
          : null}
        <h3 className="min-w-0 flex-1 truncate text-sm font-semibold text-[color:var(--tx)]">
          {title}
        </h3>
        {headerAction}
      </div>
      <div
        className="flex-1 overflow-y-auto p-3"
        onScroll={scroll.onScroll}
        ref={scroll.ref}
      >
        {children}
      </div>
      {resize ? <ColumnResizeHandle {...resize} /> : null}
    </div>
  )
}
