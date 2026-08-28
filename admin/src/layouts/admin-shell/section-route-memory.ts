import { activeNavSection, type NavSectionId } from './nav-items'

// Where the reader last stood inside each top-level section (Channels,
// Projects, Knowledge, Admin, Search). The desktop rail buttons carry a static
// section root (`/settings` for Admin), so leaving a section and returning
// always dropped you back on that root — losing which admin page you were on
// and its URL state. This tiny in-memory ledger lets the rail return you to the
// exact place instead, so switching tabs feels like the tab was never left.
//
// Session-scoped and deliberately not persisted: a full reload lands on the
// real URL anyway, so there is nothing to restore across it. Same module-store
// shape as useRecentChannels, minus the storage round-trip.
const lastPathBySection = new Map<NavSectionId, string>()

// Record the current location against the section it belongs to. `fullPath`
// keeps the query/hash (e.g. `/agents/designer?parentId=x`) so restoring lands
// on the exact screen state, while section classification runs on the pathname.
export const recordSectionRoute = (pathname: string, fullPath: string): void => {
  const section = activeNavSection(pathname)
  if (!section) return
  lastPathBySection.set(section, fullPath)
}

export const getSectionRoute = (section: NavSectionId): string | undefined =>
  lastPathBySection.get(section)

// The navigation target for a section's tab button: the remembered place if the
// reader has been there this session, else the section's canonical root.
export const resolveSectionNavTarget = (section: NavSectionId, root: string): string =>
  lastPathBySection.get(section) ?? root

// Test-only: reset the module store between cases.
export const __resetSectionRouteMemory = (): void => {
  lastPathBySection.clear()
}
