/** Messages emitted by the hosted admin across the persistent WebView bridge. */
export type NativeShellMessage = {
  accent?: string
  active?: boolean
  assignedWork?: number
  canBack?: boolean
  canForward?: boolean
  channels?: number
  color?: string
  inactive?: string
  knowledge?: number
  name?: string
  path?: string
  recentOpen?: boolean
  scheme?: string
  surface?: string
  total?: number
  type?: string
  url?: string
}
