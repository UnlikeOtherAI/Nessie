import type { ComponentProps } from 'react'
import type MaterialIcons from '@expo/vector-icons/MaterialIcons'
import type { SFSymbol } from 'sf-symbols-typescript'

type MaterialIconName = ComponentProps<typeof MaterialIcons>['name']

// The native bottom tab bar mirrors the admin's top-level sections. Tapping a tab
// drives the WebView to `path` (window.__nessieNavigate); the SPA reports its
// route back so `matches` can resync the selected tab. iOS uses SF Symbols for
// the glass bar; Android uses Material icons (rendered to image sources).
export type TabKey = 'channels' | 'projects' | 'agents' | 'knowledge' | 'admin'

export type TabDef = {
  key: TabKey
  title: string
  path: string
  sfSymbol: SFSymbol
  materialIcon: MaterialIconName
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
    materialIcon: 'forum',
    matches: (p) => p.startsWith('/channels'),
  },
  {
    key: 'projects',
    title: 'Projects',
    path: '/projects',
    sfSymbol: 'folder',
    materialIcon: 'folder',
    matches: (p) => p.startsWith('/projects'),
  },
  {
    key: 'agents',
    title: 'Agents',
    path: '/agents',
    sfSymbol: 'sparkles',
    materialIcon: 'smart-toy',
    matches: (p) => p.startsWith('/agents'),
  },
  {
    key: 'knowledge',
    title: 'Knowledge',
    path: '/knowledge-base',
    sfSymbol: 'book',
    materialIcon: 'menu-book',
    matches: (p) => p.startsWith('/knowledge-base'),
  },
  {
    key: 'admin',
    title: 'Admin',
    path: '/settings',
    sfSymbol: 'gearshape',
    materialIcon: 'settings',
    matches: matchesAdmin,
  },
]

// Index of the tab owning the given SPA route; falls back to Channels.
export const tabIndexForPath = (pathname: string): number => {
  const index = TABS.findIndex((tab) => tab.matches(pathname))
  return index === -1 ? 0 : index
}
