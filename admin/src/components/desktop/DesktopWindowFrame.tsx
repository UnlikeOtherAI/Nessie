import { useCallback, useEffect, useState, type PropsWithChildren, type ReactElement } from 'react'
import { DesktopWindowControls } from '../../layouts/admin-shell/DesktopWindowControls'
import { desktopPlatform, type DesktopPlatform } from '../../lib/desktop'
import {
  DESKTOP_RESIZE_HANDLES,
  tauriDesktopWindowFrameAdapter,
  type DesktopWindowFrameAdapter,
} from './desktop-window-adapter'

type DesktopWindowFrameProps = PropsWithChildren<{
  adapter?: DesktopWindowFrameAdapter
  platform?: DesktopPlatform | null
}>

const attempt = (action: () => Promise<unknown>): void => {
  void Promise.resolve().then(action).catch(() => undefined)
}

/**
 * The one frame shared by the undecorated Windows and Linux windows.
 *
 * It lives above the router so the same controls, drag doorway, and resize
 * edges remain reachable on sign-in, bootstrap, error, and authenticated
 * screens. macOS keeps its native traffic lights and the web keeps its browser
 * frame, so both receive the route tree unchanged.
 */
export const DesktopWindowFrame = ({
  adapter = tauriDesktopWindowFrameAdapter,
  children,
  platform,
}: DesktopWindowFrameProps): ReactElement => {
  const resolvedPlatform = platform === undefined ? desktopPlatform() : platform
  const framed = resolvedPlatform === 'linux' || resolvedPlatform === 'windows'
  const [flush, setFlush] = useState(false)

  const readWindowState = useCallback(() => {
    if (!framed) return
    void Promise.all([adapter.isMaximized(), adapter.isFullscreen()])
      .then(([maximized, fullscreen]) => setFlush(maximized || fullscreen))
      .catch(() => undefined)
  }, [adapter, framed])

  useEffect(() => {
    if (!framed) return undefined
    let cancelled = false
    let unlisten: (() => void) | null = null
    readWindowState()
    void adapter.onResized(readWindowState).then((stop) => {
      if (cancelled) stop()
      else unlisten = stop
    }).catch(() => undefined)
    return () => {
      cancelled = true
      unlisten?.()
    }
  }, [adapter, framed, readWindowState])

  useEffect(() => {
    if (resolvedPlatform !== 'linux') return undefined
    const root = document.documentElement
    const previousPlatform = root.dataset.desktopPlatform
    root.dataset.desktopPlatform = 'linux'
    return () => {
      if (previousPlatform) root.dataset.desktopPlatform = previousPlatform
      else delete root.dataset.desktopPlatform
    }
  }, [resolvedPlatform])

  if (!framed) return <>{children}</>

  return (
    <div
      className="desktop-window-frame"
      data-flush={flush ? 'true' : 'false'}
      data-platform={resolvedPlatform}
    >
      <div
        aria-hidden="true"
        className="desktop-window-frame-drag"
        data-tauri-drag-region
        onDoubleClick={resolvedPlatform === 'linux'
          ? () => attempt(() => adapter.toggleMaximize())
          : undefined}
      />
      <div className="desktop-window-frame-controls">
        <DesktopWindowControls visible />
      </div>

      {children}

      {flush
        ? null
        : DESKTOP_RESIZE_HANDLES.map(({ direction, key }) => (
            <div
              aria-hidden="true"
              className={`desktop-window-frame-resize desktop-window-frame-resize--${key}`}
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
