import { isDesktopApp } from '../lib/desktop'

// The desktop (Tauri) window uses titleBarStyle "Overlay" + hiddenTitle, so the
// top inset has no native draggable title bar. This transparent strip sits along
// the very top and carries `data-tauri-drag-region`, letting the window be moved
// by dragging the top edge (next to the macOS traffic lights) without changing
// the visible layout. Desktop-only — renders nothing on web.
const DRAG_STRIP_HEIGHT = 28

export const DesktopDragRegion = () => {
  if (!isDesktopApp()) {
    return null
  }

  return (
    <div
      aria-hidden="true"
      data-tauri-drag-region
      style={{
        height: `${DRAG_STRIP_HEIGHT}px`,
        left: 0,
        position: 'fixed',
        right: 0,
        top: 0,
        zIndex: 1000,
      }}
    />
  )
}
