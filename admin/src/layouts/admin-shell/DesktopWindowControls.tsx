import {
  currentMonitor,
  getCurrentWindow,
  PhysicalPosition,
  PhysicalSize,
} from '@tauri-apps/api/window'
import { useEffect, useRef, useState } from 'react'
import { usesCustomDesktopWindowControls } from '../../lib/desktop'
import { WindowLayoutPopover } from './WindowLayoutPopover'
import { windowLayoutBounds, type WindowLayout } from './window-layouts'

const LAYOUT_HOVER_DELAY_MS = 800
const LAYOUT_CLOSE_DELAY_MS = 180

const ControlMark = ({ kind }: { kind: 'close' | 'maximize' | 'minimize' }) => {
  if (kind === 'close') {
    return <span aria-hidden="true">×</span>
  }

  if (kind === 'minimize') {
    return <span aria-hidden="true">−</span>
  }

  return <span aria-hidden="true">+</span>
}

type DesktopWindowControlsProps = {
  visible?: boolean
}

// Windows and Linux use an overlay title bar, so they need a visible doorway
// to the native window actions. macOS retains its OS-provided traffic lights.
export const DesktopWindowControls = ({
  visible = usesCustomDesktopWindowControls(),
}: DesktopWindowControlsProps = {}) => {
  const [maximized, setMaximized] = useState(false)
  const [windowFocused, setWindowFocused] = useState(true)
  const [layoutsOpen, setLayoutsOpen] = useState(false)
  const layoutOpenTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const layoutCloseTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const layoutTriggerRef = useRef<HTMLButtonElement>(null)
  const clearLayoutTimers = () => {
    if (layoutOpenTimer.current) clearTimeout(layoutOpenTimer.current)
    if (layoutCloseTimer.current) clearTimeout(layoutCloseTimer.current)
    layoutOpenTimer.current = null
    layoutCloseTimer.current = null
  }

  useEffect(() => {
    if (!visible) return undefined
    let active = true
    let unlistenFocusChanged: (() => void) | undefined
    const appWindow = getCurrentWindow()
    void Promise.all([appWindow.isMaximized(), appWindow.isFocused()]).then(([isMaximized, isFocused]) => {
      if (!active) return
      setMaximized(isMaximized)
      setWindowFocused(isFocused)
    })
    void appWindow.onFocusChanged(({ payload: isFocused }) => {
      if (active) setWindowFocused(isFocused)
    }).then((unlisten) => {
      if (active) unlistenFocusChanged = unlisten
      else unlisten()
    })
    return () => {
      active = false
      unlistenFocusChanged?.()
      clearLayoutTimers()
    }
  }, [visible])

  if (!visible) return null

  const toggleMaximize = async () => {
    const appWindow = getCurrentWindow()
    if (maximized) await appWindow.unmaximize()
    else await appWindow.maximize()
    setMaximized(await appWindow.isMaximized())
  }

  const applyLayout = async (layout: WindowLayout) => {
    const appWindow = getCurrentWindow()
    const monitor = await currentMonitor()
    if (!monitor) return

    if (await appWindow.isFullscreen()) await appWindow.setFullscreen(false)
    if (await appWindow.isMaximized()) await appWindow.unmaximize()

    const bounds = windowLayoutBounds(layout, {
      height: monitor.workArea.size.height,
      width: monitor.workArea.size.width,
      x: monitor.workArea.position.x,
      y: monitor.workArea.position.y,
    })
    await appWindow.setSize(new PhysicalSize(bounds.width, bounds.height))
    await appWindow.setPosition(new PhysicalPosition(bounds.x, bounds.y))
    setMaximized(false)
    setLayoutsOpen(false)
  }

  const toggleFullScreen = async () => {
    const appWindow = getCurrentWindow()
    await appWindow.setFullscreen(!(await appWindow.isFullscreen()))
    setLayoutsOpen(false)
  }

  const scheduleLayoutOpen = () => {
    if (layoutCloseTimer.current) clearTimeout(layoutCloseTimer.current)
    layoutCloseTimer.current = null
    if (layoutsOpen || layoutOpenTimer.current) return
    layoutOpenTimer.current = setTimeout(() => {
      layoutOpenTimer.current = null
      setLayoutsOpen(true)
    }, LAYOUT_HOVER_DELAY_MS)
  }

  const scheduleLayoutClose = () => {
    if (layoutOpenTimer.current) clearTimeout(layoutOpenTimer.current)
    layoutOpenTimer.current = null
    if (!layoutsOpen || layoutCloseTimer.current) return
    layoutCloseTimer.current = setTimeout(() => {
      layoutCloseTimer.current = null
      setLayoutsOpen(false)
    }, LAYOUT_CLOSE_DELAY_MS)
  }

  return (
    <div
      aria-label="Window controls"
      className={`desktop-window-controls${windowFocused ? '' : ' desktop-window-controls--inactive'}`}
      role="group"
    >
      <button
        aria-label="Close window"
        className="desktop-window-control desktop-window-control--close"
        onClick={() => void getCurrentWindow().close()}
        title="Close"
        type="button"
      >
        <ControlMark kind="close" />
      </button>
      <button
        aria-label="Minimise window"
        className="desktop-window-control desktop-window-control--minimize"
        onClick={() => void getCurrentWindow().minimize()}
        title="Minimise"
        type="button"
      >
        <ControlMark kind="minimize" />
      </button>
      <button
        aria-label={maximized ? 'Restore window' : 'Maximise window'}
        aria-expanded={layoutsOpen}
        aria-haspopup="dialog"
        className="desktop-window-control desktop-window-control--maximize"
        onBlur={scheduleLayoutClose}
        onClick={() => {
          clearLayoutTimers()
          setLayoutsOpen(false)
          void toggleMaximize()
        }}
        onFocus={scheduleLayoutOpen}
        onMouseEnter={scheduleLayoutOpen}
        onMouseLeave={scheduleLayoutClose}
        ref={layoutTriggerRef}
        title={`${maximized ? 'Restore' : 'Maximise'} — hover for layouts`}
        type="button"
      >
        <ControlMark kind="maximize" />
      </button>
      <WindowLayoutPopover
        anchorRef={layoutTriggerRef}
        onClose={() => {
          clearLayoutTimers()
          setLayoutsOpen(false)
        }}
        onFullScreen={() => void toggleFullScreen()}
        onLayout={(layout) => void applyLayout(layout)}
        onPointerEnter={clearLayoutTimers}
        onPointerLeave={scheduleLayoutClose}
        open={layoutsOpen}
      />
    </div>
  )
}
