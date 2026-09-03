/** The `nessie:haptic` bridge message's coarse feedback kinds. */
export type HapticKind = 'light' | 'medium' | 'heavy' | 'selection' | 'success' | 'warning' | 'error'

/** The `nessie:screen` bridge message's section — mirrors `TabKey` (tabs.ts). */
export type ScreenSection = 'channels' | 'projects' | 'knowledge' | 'admin' | 'search'

/** The `nessie:screen` bridge message's screen node type, from the surface registry. */
export type ScreenType = 'root' | 'detail' | 'nested' | 'tabHost' | 'flow'

/** Messages emitted by the hosted admin across the persistent WebView bridge. */
export type NativeShellMessage = {
  accent?: string
  accentStrong?: string
  active?: boolean
  authorizationUrl?: string
  badges?: Record<string, number>
  canBack?: boolean
  canForward?: boolean
  depth?: number
  hasBack?: boolean
  hasBackDepth?: boolean
  haptic?: HapticKind
  color?: string
  headerSurface?: string
  headerText?: string
  inactive?: string
  id?: number
  name?: string
  path?: string
  recentOpen?: boolean
  screenType?: string
  scheme?: string
  section?: string
  state?: string
  surface?: string
  text?: string
  textMuted?: string
  title?: string
  onAccent?: string
  type?: string
  url?: string
  userAvatarUrl?: string
  userFocusMode?: boolean
  userName?: string
  userPresence?: 'away' | 'offline' | 'online'
  userStatusEmoji?: string
  teamAvatarUrl?: string
}

const SCREEN_SECTIONS: ReadonlySet<string> = new Set<ScreenSection>([
  'channels',
  'projects',
  'knowledge',
  'admin',
  'search',
])

const SCREEN_TYPES: ReadonlySet<string> = new Set<ScreenType>([
  'root',
  'detail',
  'nested',
  'tabHost',
  'flow',
])

export type ScreenMessage = NativeShellMessage & {
  depth: number
  hasBack: boolean
  path: string
  screenType: ScreenType
  section: ScreenSection
  title: string
  type: 'nessie:screen'
}

/**
 * The admin already knows which section, and what kind of screen, it is
 * standing on — this replaces the shell's own path matching (tabs.ts
 * `tabIndexForSection`). The screen's own node type travels as `screenType`
 * on the wire rather than `type`, because `type` is already the bridge
 * message's own discriminant (`'nessie:screen'`).
 */
export const isScreenMessage = (message: NativeShellMessage): message is ScreenMessage =>
  message.type === 'nessie:screen'
  && typeof message.path === 'string'
  && typeof message.title === 'string'
  && typeof message.section === 'string' && SCREEN_SECTIONS.has(message.section)
  && typeof message.screenType === 'string' && SCREEN_TYPES.has(message.screenType)
  && typeof message.depth === 'number'
  && typeof message.hasBack === 'boolean'

export type AttentionMessage = NativeShellMessage & {
  badges: Record<string, number>
  type: 'nessie:attention'
}

/** A badge count per section; a section the admin omits reads as 0 — see native-shell-presentation.ts. */
export const isAttentionMessage = (message: NativeShellMessage): message is AttentionMessage =>
  message.type === 'nessie:attention'
  && typeof message.badges === 'object'
  && message.badges !== null
