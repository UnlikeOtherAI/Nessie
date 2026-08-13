import type { ComponentProps } from 'react'
import type MaterialIcons from '@expo/vector-icons/MaterialIcons'
import type { TabRole } from 'react-native-bottom-tabs'
import type { SFSymbol } from 'sf-symbols-typescript'

type MaterialIconName = ComponentProps<typeof MaterialIcons>['name']

// The native bottom tab bar mirrors the admin's top-level sections. Tapping a tab
// drives the WebView to `path` (window.__nessieNavigate); the SPA reports its
// route back so `matches` can resync the selected tab. iOS uses SF Symbols for
// the glass bar; Android uses Material icons. The
// Search tab uses the iOS 26 search role so it renders separated on the trailing
// edge.
export type TabKey = 'channels' | 'projects' | 'knowledge' | 'admin' | 'search'

export type TabDef = {
  key: TabKey
  title: string
  path: string
  sfSymbol: SFSymbol
  materialIcon: MaterialIconName
  role?: TabRole
  matches: (pathname: string) => boolean
}

// Agents, workflows and the MCP app store now live under the Admin section.
const ADMIN_PREFIXES = [
  '/settings',
  '/agents',
  '/workflows',
  '/mcp-app-store',
  '/approvals',
  '/audit',
  '/tokens',
  '/policy',
  '/ops',
]

const matchesAdmin = (pathname: string): boolean =>
  ADMIN_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`))

export const TABS: TabDef[] = [
  {
    key: 'channels',
    title: 'Channels',
    path: '/channels',
    sfSymbol: 'message',
    materialIcon: 'chat-bubble-outline',
    matches: (p) => p.startsWith('/channels'),
  },
  {
    key: 'projects',
    title: 'Projects',
    path: '/projects',
    sfSymbol: 'folder',
    materialIcon: 'folder-open',
    matches: (p) => p.startsWith('/projects'),
  },
  {
    key: 'knowledge',
    title: 'Knowledge',
    path: '/knowledge-base',
    sfSymbol: 'book',
    materialIcon: 'menu-book',
    // Dashboards live inside Knowledge in the admin's own IA, so the tab
    // owns that route too — otherwise the bar highlights Channels while
    // showing a dashboard.
    matches: (p) => p.startsWith('/knowledge-base') || p.startsWith('/dashboards'),
  },
  {
    key: 'admin',
    title: 'Admin',
    path: '/settings',
    sfSymbol: 'gearshape',
    materialIcon: 'settings',
    matches: matchesAdmin,
  },
  {
    key: 'search',
    title: 'Search',
    path: '/search',
    sfSymbol: 'magnifyingglass',
    materialIcon: 'search',
    role: 'search',
    matches: (p) => p.startsWith('/search'),
  },
]

// Index of the tab owning the given SPA route; falls back to Channels.
export const tabIndexForPath = (pathname: string): number => {
  const index = TABS.findIndex((tab) => tab.matches(pathname))
  return index === -1 ? 0 : index
}
