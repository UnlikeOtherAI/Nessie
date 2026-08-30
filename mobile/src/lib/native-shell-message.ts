/** Messages emitted by the hosted admin across the persistent WebView bridge. */
export type NativeShellMessage = {
  accent?: string
  accentStrong?: string
  active?: boolean
  assignedWork?: number
  canBack?: boolean
  canForward?: boolean
  hasBackDepth?: boolean
  channels?: number
  color?: string
  headerSurface?: string
  headerText?: string
  inactive?: string
  id?: number
  knowledge?: number
  name?: string
  path?: string
  recentOpen?: boolean
  scheme?: string
  state?: string
  surface?: string
  text?: string
  textMuted?: string
  onAccent?: string
  total?: number
  type?: string
  url?: string
  userAvatarUrl?: string
  userFocusMode?: boolean
  userName?: string
  userPresence?: 'away' | 'offline' | 'online'
  userStatusEmoji?: string
  workspaceAvatarUrl?: string
}
