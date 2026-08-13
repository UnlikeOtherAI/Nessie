export type ToolbarAction = 'back' | 'forward' | 'history' | 'help'

export type ToolbarState = {
  canBack: boolean
  canForward: boolean
  recentOpen: boolean
}

export const DEFAULT_TOOLBAR_STATE: ToolbarState = {
  canBack: false,
  canForward: false,
  recentOpen: false,
}
