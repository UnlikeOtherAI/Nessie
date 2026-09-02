import type { ComponentProps } from 'react'
import type MaterialIcons from '@expo/vector-icons/MaterialIcons'
import type { TabRole } from 'react-native-bottom-tabs'
import type { SFSymbol } from 'sf-symbols-typescript'

type MaterialIconName = ComponentProps<typeof MaterialIcons>['name']

// The native bottom tab bar mirrors the admin's top-level sections. Tapping a
// tab drives the WebView to `path` (window.__nessieNavigate). Which tab is
// selected is never re-derived by matching the WebView's reported path
// against a copy of the admin's routing table — the admin already knows which
// section a screen belongs to, and posts it directly on the `nessie:screen`
// bridge message (native-shell-message.ts `isScreenMessage`); the shell reads
// `section` off that message. iOS uses SF Symbols for the glass bar; Android
// uses Material icons. The Search tab uses the iOS 26 search role so it
// renders separated on the trailing edge.
export type TabKey = 'channels' | 'projects' | 'knowledge' | 'admin' | 'search'

export type TabDef = {
  key: TabKey
  title: string
  path: string
  sfSymbol: SFSymbol
  materialIcon: MaterialIconName
  role?: TabRole
}

export const TABS: TabDef[] = [
  {
    key: 'channels',
    title: 'Channels',
    path: '/channels',
    sfSymbol: 'message',
    materialIcon: 'chat-bubble-outline',
  },
  {
    key: 'projects',
    title: 'Projects',
    path: '/projects',
    sfSymbol: 'folder',
    materialIcon: 'folder-open',
  },
  {
    key: 'knowledge',
    title: 'Knowledge',
    path: '/knowledge-base',
    sfSymbol: 'book',
    materialIcon: 'menu-book',
  },
  {
    key: 'admin',
    title: 'Admin',
    path: '/settings',
    sfSymbol: 'gearshape',
    materialIcon: 'settings',
  },
  {
    key: 'search',
    title: 'Search',
    path: '/search',
    sfSymbol: 'magnifyingglass',
    materialIcon: 'search',
    role: 'search',
  },
]

// The tab selected before the first `nessie:screen` message of a cold start
// has arrived, and whenever a reported section is unrecognized.
export const DEFAULT_TAB_KEY: TabKey = 'channels'

// Index of the tab owning a reported section; falls back to Channels for an
// unrecognized value (defensive against a stale or future admin build).
export const tabIndexForSection = (section: TabKey): number => {
  const index = TABS.findIndex((tab) => tab.key === section)
  return index === -1 ? 0 : index
}
