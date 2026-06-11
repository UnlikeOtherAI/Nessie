import type { SFSymbol } from 'sf-symbols-typescript'

// The native bottom tab bar mirrors the admin's top-level sections. Tapping a tab
// drives the WebView to `path` (window.__nessieNavigate); the SPA reports its
// route back so `matches` can resync the selected tab. SF Symbols give the iOS
// glass tab bar its native icons.
export type TabKey = 'channels' | 'projects' | 'agents' | 'knowledge' | 'admin'

export type TabDef = {
  key: TabKey
  title: string
  path: string
  sfSymbol: SFSymbol
  matches: (pathname: string) => boolean
}

const ADMIN_PREFIXES = ['/settings', '/approvals', '/audit', '/tokens', '/policy', '/ops']

const matchesAdmin = (pathname: string): boolean =>
  ADMIN_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`))

export const TABS: TabDef[] = [
  {
    key: 'channels',
    title: 'Channels',
    path: '/channels',
    sfSymbol: 'message',
    matches: (p) => p.startsWith('/channels'),
  },
  {
    key: 'projects',
    title: 'Projects',
    path: '/projects',
    sfSymbol: 'folder',
    matches: (p) => p.startsWith('/projects'),
  },
  {
    key: 'agents',
    title: 'Agents',
    path: '/agents',
    sfSymbol: 'sparkles',
    matches: (p) => p.startsWith('/agents'),
  },
  {
    key: 'knowledge',
    title: 'Knowledge',
    path: '/knowledge-base',
    sfSymbol: 'book',
    matches: (p) => p.startsWith('/knowledge-base'),
  },
  {
    key: 'admin',
    title: 'Admin',
    path: '/settings',
    sfSymbol: 'gearshape',
    matches: matchesAdmin,
  },
]

// Index of the tab owning the given SPA route; falls back to Channels.
export const tabIndexForPath = (pathname: string): number => {
  const index = TABS.findIndex((tab) => tab.matches(pathname))
  return index === -1 ? 0 : index
}
