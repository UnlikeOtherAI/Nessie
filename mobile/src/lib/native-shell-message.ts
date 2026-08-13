/** Messages emitted by the hosted admin across the persistent WebView bridge. */
export type NativeShellMessage = {
  accent?: string
  accentStrong?: string
  active?: boolean
  assignedWork?: number
  canBack?: boolean
  canForward?: boolean
  channels?: number
  color?: string
  headerSurface?: string
  headerText?: string
  inactive?: string
  knowledge?: number
  name?: string
  path?: string
  recentOpen?: boolean
  scheme?: string
  surface?: string
  text?: string
  textMuted?: string
  onAccent?: string
  total?: number
  type?: string
  url?: string
  userAvatarUrl?: string
  userName?: string
  userPresence?: 'away' | 'offline' | 'online'
  userStatusEmoji?: string
}
