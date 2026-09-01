// The window-management seam between DesktopWindowFrame and Tauri.
//
// The frame takes this adapter as a prop so the component is testable without a
// Tauri runtime: `@tauri-apps/api/window` is only reachable behind a lazy import
// here, and every method fails soft. A window control that throws must never take
// the admin down with it — the person is still holding a usable app, and the OS
// keyboard (Alt+F4 on Windows) is always there.

export type DesktopResizeDirection =
  | 'East'
  | 'North'
  | 'NorthEast'
  | 'NorthWest'
  | 'South'
  | 'SouthEast'
  | 'SouthWest'
  | 'West'

export type DesktopWindowAdapter = {
  close: () => Promise<void>
  isFullscreen: () => Promise<boolean>
  isMaximized: () => Promise<boolean>
  minimize: () => Promise<void>
  /** Subscribes to window resizes; resolves with the unsubscribe function. */
  onResized: (handler: () => void) => Promise<() => void>
  setFullscreen: (fullscreen: boolean) => Promise<void>
  startResizeDragging: (direction: DesktopResizeDirection) => Promise<void>
  toggleMaximize: () => Promise<void>
}

type TauriWindowModule = typeof import('@tauri-apps/api/window')

const loadCurrentWindow = async (): Promise<ReturnType<TauriWindowModule['getCurrentWindow']>> => {
  const module: TauriWindowModule = await import('@tauri-apps/api/window')
  return module.getCurrentWindow()
}

/** The real adapter. Every call resolves the current window lazily, so importing
 *  this module in a browser (or a test) never touches the Tauri internals. */
export const tauriWindowAdapter: DesktopWindowAdapter = {
  close: async () => {
    await (await loadCurrentWindow()).close()
  },
  isFullscreen: async () => (await loadCurrentWindow()).isFullscreen(),
  isMaximized: async () => (await loadCurrentWindow()).isMaximized(),
  minimize: async () => {
    await (await loadCurrentWindow()).minimize()
  },
  onResized: async (handler) => (await loadCurrentWindow()).onResized(() => handler()),
  setFullscreen: async (fullscreen) => {
    await (await loadCurrentWindow()).setFullscreen(fullscreen)
  },
  startResizeDragging: async (direction) => {
    await (await loadCurrentWindow()).startResizeDragging(direction)
  },
  toggleMaximize: async () => {
    await (await loadCurrentWindow()).toggleMaximize()
  },
}

/** The eight resize handles an undecorated window has to draw itself, in the
 *  order they are rendered. Edges first so the corners stack above them. */
export const DESKTOP_RESIZE_HANDLES: readonly {
  direction: DesktopResizeDirection
  key: string
}[] = [
  { direction: 'North', key: 'n' },
  { direction: 'South', key: 's' },
  { direction: 'West', key: 'w' },
  { direction: 'East', key: 'e' },
  { direction: 'NorthWest', key: 'nw' },
  { direction: 'NorthEast', key: 'ne' },
  { direction: 'SouthWest', key: 'sw' },
  { direction: 'SouthEast', key: 'se' },
]
