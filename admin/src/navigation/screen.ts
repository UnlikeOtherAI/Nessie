// What screen a person is on, as one published fact.
//
// The header is the only thing that knows a screen's title — the registry
// classifies a route but cannot name "Design review" or "Ada Lovelace" — so
// `ScreenHeader` publishes its rendered title here, keyed by the pathname of
// the layer it rendered under. The shell then reads the title for the *live*
// location and turns it into the two things outside the document that name a
// screen: the browser tab (`document.title`) and the native shell's
// `nessie:screen` message (docs/navigation/overview.md §9, plan §4.9/§4.16).
//
// Keying by pathname rather than keeping one "current" title is what makes
// this correct under the navigation stack: retained and seeded layers stay
// mounted with their own `UNSAFE_LocationContext`, so several headers are
// alive at once and each publishes under the route it actually renders.

import { useSyncExternalStore } from 'react'
import type { SurfaceSection, SurfaceType } from './page-types'
import { matchSurface, normalizeNavigationPathname } from './surfaces'

export const SCREEN_MESSAGE_TYPE = 'nessie:screen'

// The six fields the native shell reads. `section`, `screenType` and `depth`
// come straight off the surface registry; `title` is the header's rendered
// title and `hasBack` is the one Back resolver's answer for this route. The
// page type is `screenType`, not `type`: `type` is the bridge's own message
// discriminant (`nessie:screen`), and one key cannot be both.
export type ScreenMessage = {
  depth: number
  hasBack: boolean
  path: string
  screenType: SurfaceType | null
  section: SurfaceSection | null
  title: string
}

// `<screen title> · Nessie`. An empty title (a screen whose header has not
// published yet) leaves the product name alone rather than rendering a
// leading separator.
export const screenDocumentTitle = (title: string): string => {
  const trimmed = title.trim()
  return trimmed ? `${trimmed} · Nessie` : 'Nessie'
}

export const describeScreen = (
  pathname: string,
  title: string,
  hasBack: boolean,
): ScreenMessage => {
  const matched = matchSurface(pathname)
  return {
    depth: matched?.surface.depth ?? 0,
    hasBack,
    path: normalizeNavigationPathname(pathname),
    screenType: matched?.surface.type ?? null,
    section: matched?.surface.section ?? null,
    title: title.trim(),
  }
}

// Field-by-field, so a re-render that changes nothing posts nothing and any
// settled change of any field posts once.
export const sameScreen = (left: ScreenMessage | null, right: ScreenMessage): boolean =>
  left !== null
  && left.depth === right.depth
  && left.hasBack === right.hasBack
  && left.path === right.path
  && left.screenType === right.screenType
  && left.section === right.section
  && left.title === right.title

// The two things outside the document that name a screen, applied together
// so the browser tab and the native chrome can never disagree. `post` is the
// native bridge's poster, or null off the native shell.
export const applyScreen = (
  screen: ScreenMessage,
  post: ((payload: string) => void) | null,
): void => {
  document.title = screenDocumentTitle(screen.title)
  post?.(JSON.stringify({ ...screen, type: SCREEN_MESSAGE_TYPE }))
}

const titles = new Map<string, string>()
const listeners = new Set<() => void>()
let revision = 0

const notify = (): void => {
  revision += 1
  for (const listener of listeners) listener()
}

export const publishScreenTitle = (pathname: string, title: string): void => {
  const key = normalizeNavigationPathname(pathname)
  if (titles.get(key) === title) return
  titles.set(key, title)
  notify()
}

// Only the publisher that still owns the entry retires it: two headers can
// briefly overlap on one path while a screen re-renders, and the leaving one
// must not delete the arriving one's title.
export const retireScreenTitle = (pathname: string, title: string): void => {
  const key = normalizeNavigationPathname(pathname)
  if (titles.get(key) !== title) return
  titles.delete(key)
  notify()
}

export const screenTitleFor = (pathname: string): string =>
  titles.get(normalizeNavigationPathname(pathname)) ?? ''

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

const snapshot = (): number => revision

export const useScreenTitle = (pathname: string): string => {
  useSyncExternalStore(subscribe, snapshot, snapshot)
  return screenTitleFor(pathname)
}

// Test seam only: the registry is module state shared by every header.
export const resetScreenTitles = (): void => {
  titles.clear()
  notify()
}
