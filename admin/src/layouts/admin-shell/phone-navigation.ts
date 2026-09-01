import type { SurfaceParent, SurfaceScreen } from '../../navigation/page-types'
import {
  matchSurface,
  normalizeNavigationPathname,
  surfaceParent,
  surfaceRootPath,
  surfaceScreen,
} from '../../navigation/surfaces'

// The phone shell's view of the surface registry. Every fact below comes from
// `admin/src/navigation/surfaces.ts` — this module only adapts it to the
// names the phone stack, the ledger, the Back doorway and the native bridge
// already consume. Nothing here classifies a route itself: a route family
// without a registry row is a lint failure, not a fallback.
export type PhoneNavigationDirection = 'back' | 'forward'

export type PhoneNavigationBackTarget = SurfaceParent

// Numeric route depth: tab roots are 0; the channel info chain walks depth 1
// (conversation) → 4 (add-members) and /dashboards/:id sits at depth 2 under
// /dashboards (itself a Knowledge-section detail).
export type PhoneNavigationScreen = SurfaceScreen

// Every matcher works on the normalized pathname: entries in the route-history
// ledger store the full path (pathname + search + hash) so navigation can
// reproduce the location byte-for-byte, while semantic parents, tab roots, and
// screen identities compare pathnames only — `/channels?filter=unread` is the
// Channels root, not a detail.
const normalizePathname = normalizeNavigationPathname

// Phone tab roots (depth 0) are the native tab bar's destinations. Roots with
// a contextual list render that list as the page (and show the Menu doorway);
// /search is a full outlet page. /dashboards is not a tab root — it is a
// Knowledge-section detail that renders its outlet as the page.
export const isPhoneTabRoot = (pathname: string): boolean =>
  matchSurface(pathname)?.surface.type === 'root'

// Does this section's root page render a contextual navigation list (the
// channels/projects/knowledge/admin sidebars)? Search and Dashboards render
// their outlet instead.
export const phoneTabRootHasContextualList = (pathname: string): boolean =>
  matchSurface(pathname)?.surface.contextualList === true

// Which tab a route belongs to. Distinct from isPhoneTabRoot: a tab's detail
// routes also belong to the tab.
export const getPhoneTabRootPath = (pathname: string): string =>
  surfaceRootPath(pathname)

// Phone navigation is a per-section stack: each tab starts at depth 0 and
// nested routes walk deeper where the UI owns another screen. Project
// sections and sibling detail selections stay at their current depth, so
// changing a tab, query, entity, or project section does not replay a
// route-level transition. Detail keys are section-scoped where one mounted
// page swaps its content in place — channel A → B, Knowledge space A → B,
// settings page A → B.
export const getPhoneNavigationScreen = (
  pathname: string,
): PhoneNavigationScreen | null => surfaceScreen(pathname)

// The shared route-level Back: every phone detail screen returns to a
// specific parent with a human-readable label. Tab roots return null (they
// show the Menu doorway instead). This destination is the cold-deep-link
// fallback; the shared Back action pops real history first when the previous
// in-app entry already is this parent.
export const getPhoneNavigationBackTarget = (
  pathname: string,
): PhoneNavigationBackTarget | null => surfaceParent(pathname)

export const getPhoneNavigationDirection = (
  fromPathname: string,
  toPathname: string,
): PhoneNavigationDirection | null => {
  const from = getPhoneNavigationScreen(fromPathname)
  const to = getPhoneNavigationScreen(toPathname)

  if (!from || !to || from.section !== to.section || from.depth === to.depth) {
    return null
  }

  return to.depth > from.depth ? 'forward' : 'back'
}

// The navigation action a route-level Back should take. `pop` when the entry
// behind the current one is the semantic parent (so Back unwinds history
// instead of duplicating it), otherwise `replace` the current entry with the
// deterministic parent — a cold deep link has no in-app history to unwind,
// and replacing it means browser Back from the parent can never loop back
// onto the detail it just left. The previous-entry comparison normalizes:
// `/channels?filter=unread` behind `/channels/chan_a` is still the parent.
export type PhoneNavigationBackAction =
  | { mode: 'pop'; to: string }
  | { mode: 'replace'; to: string }
  | null

export const resolvePhoneNavigationBackAction = (
  pathname: string,
  previousPathname?: string | null,
): PhoneNavigationBackAction => {
  const target = getPhoneNavigationBackTarget(pathname)
  if (!target) return null
  const previous = previousPathname ? normalizePathname(previousPathname) : null
  // A `parent: 'origin'` screen (the bell's alerts, feedback) is reachable
  // from every section, so its parent is wherever the reader actually came
  // from: pop to any in-app predecessor the ledger knows, and fall back to
  // the declared parent only on a cold deep link.
  if (matchSurface(pathname)?.surface.parent === 'origin') {
    if (previous && getPhoneNavigationScreen(previous)) {
      return { mode: 'pop', to: previous }
    }
    return { mode: 'replace', to: target.pathname }
  }
  if (previous === target.pathname) {
    return { mode: 'pop', to: target.pathname }
  }
  return { mode: 'replace', to: target.pathname }
}

// Android hardware Back and the shared in-app Back converge on the same
// semantic target. The native shell never matches routes itself: the page
// reports whether the current route has an in-app parent, and the shell
// consumes the key only then. At a tab root the key falls through to the
// platform default.
export const phoneRouteHasBackDepth = (pathname: string): boolean =>
  getPhoneNavigationBackTarget(pathname) !== null

// A phone Knowledge root is the space picker, not an open space. Retain the
// provider's selection so a detail can restore its workspace, but don't leave
// that prior choice painted as active after Back returns to the picker.
export const shouldHighlightKnowledgeSidebarSelection = (
  pathname: string,
  phoneLayout: boolean,
): boolean => !phoneLayout || normalizePathname(pathname) !== '/knowledge-base'
