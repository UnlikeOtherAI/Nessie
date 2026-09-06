import type { NativeScreenBarAction } from './native-shell-layout'

/** The `nessie:haptic` bridge message's coarse feedback kinds. */
export type HapticKind = 'light' | 'medium' | 'heavy' | 'selection' | 'success' | 'warning' | 'error'

/** The `nessie:screen` bridge message's section — mirrors `TabKey` (tabs.ts). */
export type ScreenSection = 'channels' | 'projects' | 'knowledge' | 'admin' | 'search'

/**
 * The `nessie:list-column` bridge message's section — the four shell sections
 * that own a pinned secondary navigation column (`SidebarSection` in
 * admin/src/layouts/admin-shell/ResizableSidebar.tsx). Deliberately not
 * `ScreenSection`: Search has no column of its own.
 */
export type ListColumnSection = 'channels' | 'projects' | 'knowledge' | 'admin'

/** The `nessie:screen` bridge message's screen node type, from the surface registry. */
export type ScreenType = 'root' | 'detail' | 'nested' | 'tabHost' | 'flow'

/** Messages emitted by the hosted admin across the persistent WebView bridge. */
export type NativeShellMessage = {
  accent?: string
  actions?: unknown
  direction?: string
  durationMs?: number
  from?: string
  to?: string
  back?: { label?: unknown } | null
  layerKey?: string | null
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
  left?: number
  right?: number
  name?: string
  path?: string
  recentOpen?: boolean
  screenType?: string
  scheme?: string
  // Null-able because `nessie:list-column` says "no pinned column" with it.
  section?: string | null
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
  /** `nessie:voice-call-start`'s provisioning payload — see native-voice-call.ts. */
  voiceCall?: unknown
  muted?: boolean
  teamAvatarUrl?: string
  /** LEGACY_NATIVE_SHELL: `nessie:workspace`'s spelling of `teamAvatarUrl`. */
  workspaceAvatarUrl?: string
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

const LIST_COLUMN_SECTIONS: ReadonlySet<string> = new Set<ListColumnSection>([
  'channels',
  'projects',
  'knowledge',
  'admin',
])

/**
 * `nessie:list-column` — where the pinned secondary navigation column stands,
 * in the WebView's own coordinates, and which section it belongs to.
 *
 * The shell cannot derive this: the column is resizable, its width is a
 * per-section preference, and only the document knows where it ended up. A
 * `section` of null is the admin saying there is no pinned column — a phone
 * layout, or a route that has none — and is what retires native chrome drawn
 * over it.
 */
export type ListColumnMessage = NativeShellMessage & {
  left: number
  right: number
  section: ListColumnSection | null
  type: 'nessie:list-column'
}

export const isListColumnMessage = (message: NativeShellMessage): message is ListColumnMessage =>
  message.type === 'nessie:list-column'
  && typeof message.left === 'number' && Number.isFinite(message.left)
  && typeof message.right === 'number' && Number.isFinite(message.right)
  && message.right > message.left
  && (message.section === null
    || (typeof message.section === 'string' && LIST_COLUMN_SECTIONS.has(message.section)))

export type AttentionMessage = NativeShellMessage & {
  badges: Record<string, number>
  type: 'nessie:attention'
}

/** A badge count per section; a section the admin omits reads as 0 — see native-shell-presentation.ts. */
export const isAttentionMessage = (message: NativeShellMessage): message is AttentionMessage =>
  message.type === 'nessie:attention'
  && typeof message.badges === 'object'
  && message.badges !== null

/**
 * `nessie:screen-bar` — what the native navigation bar shows for the layer the
 * reader is standing on.
 *
 * Keyed by the admin's stack layer, not by a pathname: a nested stage never
 * changes the pathname, and a channel and its info route are two screens on
 * one route. `back` is the Back the screen's own header would run — a Flow
 * that owns its Back returns somewhere the route registry cannot name — so the
 * chevron calls back into the page rather than resolving anything here.
 *
 * `title` is allowed to be empty: a layer that has not published yet (a cold
 * start, the frame after a forward push) renders a bare band rather than
 * falling back to a root's team controls.
 */
export type ScreenBarMessage = NativeShellMessage & {
  actions: NativeScreenBarAction[]
  back: { label: string } | null
  layerKey: string | null
  title: string
  type: 'nessie:screen-bar'
}

const SCREEN_BAR_ACTION_KINDS: ReadonlySet<string> = new Set(['button', 'link', 'menu', 'toggle'])

const isScreenBarAction = (value: unknown): value is NativeScreenBarAction => {
  if (typeof value !== 'object' || value === null) return false
  const action = value as Record<string, unknown>
  return typeof action.id === 'string'
    && typeof action.label === 'string'
    && typeof action.priority === 'number'
    && typeof action.kind === 'string' && SCREEN_BAR_ACTION_KINDS.has(action.kind)
}

export const isScreenBarMessage = (message: NativeShellMessage): message is ScreenBarMessage =>
  message.type === 'nessie:screen-bar'
  && typeof message.title === 'string'
  // Every field is required even when empty. The bridge always sends all
  // three, so an absent one is a malformed message rather than a bar with
  // nothing to say — and a bar rendered from a half-message would sit there
  // until the next navigation.
  && (message.layerKey === null || typeof message.layerKey === 'string')
  && (message.back === null || typeof message.back?.label === 'string')
  // One malformed action refuses the whole bar rather than silently dropping
  // a control: a header action nobody can reach is the failure Rule zero
  // names, and a bar that quietly lost one would look complete.
  && Array.isArray(message.actions)
  && message.actions.every(isScreenBarAction)

/**
 * `nessie:screen-transition` — the stack is moving, so the bar moves with it.
 *
 * `from` and `to` are layer keys. The bar cannot animate off `nessie:screen-bar`
 * alone: that says which layer is current, not that it is changing, and on a
 * forward push it arrives before the incoming layer has mounted. The incoming
 * descriptor may therefore not have been posted yet — that lane fills late
 * rather than restarting the animation.
 */
export type ScreenTransitionMessage = NativeShellMessage & {
  direction: 'back' | 'forward'
  durationMs: number
  from: string
  to: string
  type: 'nessie:screen-transition'
}

export const isScreenTransitionMessage = (
  message: NativeShellMessage,
): message is ScreenTransitionMessage =>
  message.type === 'nessie:screen-transition'
  && (message.direction === 'back' || message.direction === 'forward')
  && typeof message.durationMs === 'number'
  && Number.isFinite(message.durationMs)
  && typeof message.from === 'string'
  && typeof message.to === 'string'
