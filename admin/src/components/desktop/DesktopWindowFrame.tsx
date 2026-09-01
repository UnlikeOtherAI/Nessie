import { useCallback, useEffect, useState, type PropsWithChildren, type ReactElement } from 'react'
import type { DesktopPlatform } from '../../lib/desktop'
import { useShellEnvironment } from '../../providers/ShellEnvironmentProvider'
import {
  DESKTOP_RESIZE_HANDLES,
  tauriWindowAdapter,
  type DesktopWindowAdapter,
} from './desktop-window-adapter'

/**
 * The one window frame for every desktop platform that draws its own chrome.
 *
 * The Windows and Linux shells run `decorations: false` (design:
 * docs/plans/2026-09-01-linux-desktop-delivery.md → "Shared shell contract"),
 * so the admin owns the title bar, the window controls, and the resize border
 * that the OS would otherwise draw. macOS keeps the overlay title bar with its
 * traffic lights, and the web build has a browser — both render `children`
 * untouched, so this component is a no-op everywhere but the two frameless
 * shells and there is exactly one implementation for those two.
 *
 * Presentation differences are CSS, keyed off `data-platform`, not a second
 * component: Windows lets the OS draw the shadow and (on 11) the rounded
 * corners, while Linux runs a transparent window and paints its own 12px
 * radius plus a soft shadow into a transparent gutter.
 */

const iconProps = {
  'aria-hidden': true,
  fill: 'none',
  focusable: false,
  height: 10,
  stroke: 'currentColor',
  strokeLinecap: 'round',
  strokeWidth: 1.4,
  viewBox: '0 0 10 10',
  width: 10,
} as const

const MinimizeIcon = () => (
  <svg {...iconProps}>
    <path d="M0.75 5h8.5" />
  </svg>
)

const MaximizeIcon = () => (
  <svg {...iconProps}>
    <rect height="8" rx="1" width="8" x="1" y="1" />
  </svg>
)

const RestoreIcon = () => (
  <svg {...iconProps}>
    <rect height="6.5" rx="1" width="6.5" x="0.75" y="2.75" />
    <path d="M3 2.5V1.75A1 1 0 0 1 4 0.75h4.25A1 1 0 0 1 9.25 1.75V6a1 1 0 0 1-1 1H7.5" />
  </svg>
)

const CloseIcon = () => (
  <svg {...iconProps}>
    <path d="m1 1 8 8M9 1l-8 8" />
  </svg>
)

type WindowState = {
  fullscreen: boolean
  maximized: boolean
}

type DesktopWindowFrameProps = PropsWithChildren<{
  /** Injected in tests; production always uses the lazy Tauri adapter. */
  adapter?: DesktopWindowAdapter
  /** Injected in tests; production reads the shell environment. */
  platform?: DesktopPlatform | null
}>

// A window control that throws must not take the app down: the person is still
// holding a usable window and the OS keyboard (Alt+F4, the window menu) still
// works. Every call is therefore best-effort, exactly like the badge bridge.
const attempt = (action: () => Promise<unknown>): void => {
  void Promise.resolve()
    .then(action)
    .catch(() => undefined)
}

export const DesktopWindowFrame = ({
  adapter = tauriWindowAdapter,
  children,
  platform,
}: DesktopWindowFrameProps): ReactElement => {
  const shell = useShellEnvironment()
  const resolved = platform === undefined ? shell.desktopPlatform : platform
  const framed = resolved === 'linux' || resolved === 'windows'
  const [state, setState] = useState<WindowState>({ fullscreen: false, maximized: false })

  const readState = useCallback(() => {
    if (!framed) return
    void Promise.all([adapter.isMaximized(), adapter.isFullscreen()])
      .then(([maximized, fullscreen]) => setState({ fullscreen, maximized }))
      .catch(() => undefined)
  }, [adapter, framed])

  // The OS is the authority on the window state — a snap gesture, Win+Arrow, a
  // tiling window manager and our own buttons all end up here through onResized,
  // so the frame never has to guess what it did.
  useEffect(() => {
    if (!framed) return
    let unlisten: (() => void) | null = null
    let cancelled = false
    readState()
    void adapter
      .onResized(() => readState())
      .then((stop) => {
        if (cancelled) stop()
        else unlisten = stop
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
      unlisten?.()
    }
  }, [adapter, framed, readState])

  // The frameless shells have no menu bar, so the two window-level shortcuts a
  // person expects are wired here. F11 is the cross-platform fullscreen key;
  // Ctrl+Q is the Linux quit convention. Windows keeps Alt+F4, which the OS
  // owns — intercepting it here would only make it less reliable.
  useEffect(() => {
    if (!framed || typeof window === 'undefined') return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'F11') {
        event.preventDefault()
        attempt(async () => {
          const fullscreen = await adapter.isFullscreen()
          await adapter.setFullscreen(!fullscreen)
          readState()
        })
        return
      }
      if (resolved === 'linux' && event.ctrlKey && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'q') {
        event.preventDefault()
        attempt(() => adapter.close())
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [adapter, framed, readState, resolved])

  // The frame's geometry has to reach `html`/`body`: on Linux the window itself
  // is transparent, so the body background must stop painting the gutter, and
  // every full-height rule resolves `--app-vh` against the inset frame instead
  // of the raw viewport.
  useEffect(() => {
    if (typeof document === 'undefined') return
    const root = document.documentElement
    if (!framed) {
      delete root.dataset.desktopFrame
      delete root.dataset.desktopFrameFlush
      return
    }
    root.dataset.desktopFrame = resolved ?? ''
    root.dataset.desktopFrameFlush = state.fullscreen || state.maximized ? 'true' : 'false'
    return () => {
      delete root.dataset.desktopFrame
      delete root.dataset.desktopFrameFlush
    }
  }, [framed, resolved, state.fullscreen, state.maximized])

  if (!framed) return <>{children}</>

  const flush = state.fullscreen || state.maximized

  return (
    <div className="desktop-frame" data-flush={flush ? 'true' : 'false'} data-platform={resolved}>
      {/*
        The drag strip sits behind the admin's own top bar (which already carries
        `data-tauri-drag-region` zones around its interactive controls) and in
        front of everything else, so the sign-in screen and the other chromeless
        routes are draggable by their top edge without covering a single button.
        Tauri applies the drag region only to the element carrying the attribute.
        On Windows the OS drag loop already maximizes on a double-click; GTK's
        move-drag does not, so Linux gets the explicit toggle.
      */}
      {state.fullscreen ? null : (
        <div
          aria-hidden="true"
          className="desktop-frame-drag"
          data-tauri-drag-region
          onDoubleClick={resolved === 'linux' ? () => attempt(() => adapter.toggleMaximize()) : undefined}
        />
      )}

      {state.fullscreen ? null : (
        <div className="desktop-frame-controls">
          <button
            aria-label="Minimize window"
            className="desktop-frame-control"
            onClick={() => attempt(() => adapter.minimize())}
            title="Minimize"
            type="button"
          >
            <MinimizeIcon />
          </button>
          <button
            aria-label={state.maximized ? 'Restore window' : 'Maximize window'}
            className="desktop-frame-control"
            onClick={() =>
              attempt(async () => {
                await adapter.toggleMaximize()
                readState()
              })
            }
            title={state.maximized ? 'Restore' : 'Maximize'}
            type="button"
          >
            {state.maximized ? <RestoreIcon /> : <MaximizeIcon />}
          </button>
          <button
            aria-label="Close window"
            className="desktop-frame-control desktop-frame-control--close"
            onClick={() => attempt(() => adapter.close())}
            title="Close"
            type="button"
          >
            <CloseIcon />
          </button>
        </div>
      )}

      {children}

      {/* An undecorated window has no OS resize border, so the frame draws its
          own — invisible, 8px, and gone while the window is maximized or
          fullscreen, where dragging an edge means nothing. */}
      {flush
        ? null
        : DESKTOP_RESIZE_HANDLES.map(({ direction, key }) => (
            <div
              aria-hidden="true"
              className={`desktop-frame-resize desktop-frame-resize--${key}`}
              key={key}
              onMouseDown={(event) => {
                if (event.button !== 0) return
                event.preventDefault()
                attempt(() => adapter.startResizeDragging(direction))
              }}
            />
          ))}
    </div>
  )
}
