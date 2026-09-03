import { getCurrentWindow } from '@tauri-apps/api/window'
import { useEffect, useState } from 'react'
import { usesCustomDesktopWindowControls } from '../../lib/desktop'

const ControlMark = ({ kind }: { kind: 'close' | 'maximize' | 'minimize' }) => {
  if (kind === 'close') {
    return <span aria-hidden="true">×</span>
  }

  if (kind === 'minimize') {
    return <span aria-hidden="true">−</span>
  }

  return <span aria-hidden="true">+</span>
}

// Windows and Linux use an overlay title bar, so they need a visible doorway
// to the native window actions. macOS retains its OS-provided traffic lights.
export const DesktopWindowControls = () => {
  const [maximized, setMaximized] = useState(false)
  const visible = usesCustomDesktopWindowControls()

  useEffect(() => {
    if (!visible) return undefined
    let active = true
    void getCurrentWindow().isMaximized().then((value) => {
      if (active) setMaximized(value)
    })
    return () => {
      active = false
    }
  }, [visible])

  if (!visible) return null

  const toggleMaximize = () => {
    void getCurrentWindow().toggleMaximize().then(() => setMaximized((value) => !value))
  }

  return (
    <div aria-label="Window controls" className="desktop-window-controls" role="group">
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
        className="desktop-window-control desktop-window-control--maximize"
        onClick={toggleMaximize}
        title={maximized ? 'Restore' : 'Maximise'}
        type="button"
      >
        <ControlMark kind="maximize" />
      </button>
    </div>
  )
}
