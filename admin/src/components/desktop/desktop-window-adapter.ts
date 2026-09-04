export type DesktopResizeDirection =
  | 'East'
  | 'North'
  | 'NorthEast'
  | 'NorthWest'
  | 'South'
  | 'SouthEast'
  | 'SouthWest'
  | 'West'

export type DesktopWindowFrameAdapter = {
  isFullscreen: () => Promise<boolean>
  isMaximized: () => Promise<boolean>
  onResized: (handler: () => void) => Promise<() => void>
  startResizeDragging: (direction: DesktopResizeDirection) => Promise<void>
  toggleMaximize: () => Promise<void>
}

type TauriWindowModule = typeof import('@tauri-apps/api/window')

const loadCurrentWindow = async (): Promise<ReturnType<TauriWindowModule['getCurrentWindow']>> => {
  const module: TauriWindowModule = await import('@tauri-apps/api/window')
  return module.getCurrentWindow()
}

export const tauriDesktopWindowFrameAdapter: DesktopWindowFrameAdapter = {
  isFullscreen: async () => (await loadCurrentWindow()).isFullscreen(),
  isMaximized: async () => (await loadCurrentWindow()).isMaximized(),
  onResized: async (handler) => (await loadCurrentWindow()).onResized(() => handler()),
  startResizeDragging: async (direction) => {
    await (await loadCurrentWindow()).startResizeDragging(direction)
  },
  toggleMaximize: async () => {
    await (await loadCurrentWindow()).toggleMaximize()
  },
}

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
