import { matchesAdminRoute, normalizeAdminPathname } from './nav-items'

export type PhoneNavigationDirection = 'back' | 'forward'

export type PhoneNavigationBackTarget = {
  label: string
  pathname: string
}

export type PhoneNavigationScreen = {
  // Numeric route depth: tab roots are 0; the channel info chain walks
  // depth 1 (conversation) → 4 (add-members) and /dashboards/:id sits at
  // depth 2 under /dashboards (itself a Knowledge-section detail).
  depth: number
  key: string
  section: 'admin' | 'channels' | 'knowledge' | 'projects' | 'search'
}

// Every matcher works on the normalized pathname: entries in the route-history
// ledger store the full path (pathname + search + hash) so navigation can
// reproduce the location byte-for-byte, while semantic parents, tab roots, and
// screen identities compare pathnames only — `/channels?filter=unread` is the
// Channels root, not a detail.
const normalizePathname = normalizeAdminPathname

// One declarative matrix owns every phone navigation fact so the tab-root
// set, the transition screen model, the Back destinations, and the native
// tab bridge cannot drift apart. Each row matches one route family and
// declares: which section (tab) it belongs to, its tab root, whether the
// root page renders the section's contextual list (vs. a full outlet page),
// and how detail routes collapse to a screen key. `identityOf` folds
// same-screen siblings (the channel's info/members sub-routes, the project's
// tab routes, admin detail paths) into the route that owns the screen's
// identity; `keyScope` scopes the wrapper key so same-depth detail screens
// stay mounted across sibling switches.
type PhoneRouteRow = {
  // The deterministic parent for the route-level Back. Absent at tab roots.
  backTo?: (match: RegExpMatchArray) => PhoneNavigationBackTarget
  contextualList?: boolean
  depth: number
  identityOf?: (match: RegExpMatchArray) => string
  keyScope?: (identity: string) => string
  pattern: RegExp
  root: string
  section: PhoneNavigationScreen['section']
}

const toChannels = (): PhoneNavigationBackTarget => ({
  label: 'Back to Channels',
  pathname: '/channels',
})
const toProjects = (): PhoneNavigationBackTarget => ({
  label: 'Back to Projects',
  pathname: '/projects',
})
const toKnowledge = (): PhoneNavigationBackTarget => ({
  label: 'Back to Knowledge',
  pathname: '/knowledge-base',
})
const toDashboards = (): PhoneNavigationBackTarget => ({
  label: 'Back to Dashboards',
  pathname: '/dashboards',
})

const PHONE_ROUTES: PhoneRouteRow[] = [
  // Channels: the conversation is depth 1, its info chain walks one step
  // deeper per inspector page so the viewport animates each level.
  { pattern: /^\/channels$/, root: '/channels', section: 'channels', depth: 0, contextualList: true },
  {
    pattern: /^\/channels\/projects\/([^/]+)$/,
    root: '/channels',
    section: 'channels',
    depth: 1,
    backTo: toChannels,
    identityOf: (match) => `project:${match[1]}`,
    keyScope: () => 'projects',
  },
  {
    // /channels/new is the compose sheet, not a stack screen.
    pattern: /^\/channels\/(?!new(?:\/|$))([^/]+)\/info\/members\/add$/,
    root: '/channels',
    section: 'channels',
    depth: 4,
    backTo: (match) => ({
      label: 'Back to members',
      pathname: `/channels/${match[1]}/info/members`,
    }),
    identityOf: (match) => `channel:${match[1]}`,
    keyScope: () => 'channel',
  },
  {
    pattern: /^\/channels\/(?!new(?:\/|$))([^/]+)\/info\/members$/,
    root: '/channels',
    section: 'channels',
    depth: 3,
    backTo: (match) => ({
      label: 'Back to channel info',
      pathname: `/channels/${match[1]}/info`,
    }),
    identityOf: (match) => `channel:${match[1]}`,
    keyScope: () => 'channel',
  },
  {
    pattern: /^\/channels\/(?!new(?:\/|$))([^/]+)\/info$/,
    root: '/channels',
    section: 'channels',
    depth: 2,
    backTo: (match) => ({
      label: 'Back to conversation',
      pathname: `/channels/${match[1]}`,
    }),
    identityOf: (match) => `channel:${match[1]}`,
    keyScope: () => 'channel',
  },
  {
    // A reply thread is a full phone screen over its conversation. Giving it
    // its own depth lets the retained conversation slide back into view when
    // its local Back control closes the panel.
    pattern: /^\/channels\/(?!new(?:\/|$))([^/]+)\/threads\/([^/]+)\/replies\/([^/]+)\/?$/,
    root: '/channels',
    section: 'channels',
    depth: 2,
    backTo: (match) => ({
      label: 'Back to conversation',
      pathname: `/channels/${match[1]}`,
    }),
    identityOf: (match) => `channel:${match[1]}`,
    keyScope: () => 'channel',
  },
  {
    pattern: /^\/channels\/(?!new(?:\/|$))([^/]+)(?:\/.*)?$/,
    root: '/channels',
    section: 'channels',
    depth: 1,
    backTo: toChannels,
    identityOf: (match) => `channel:${match[1]}`,
    keyScope: () => 'channel',
  },
  {
    pattern: /^\/unread-messages$/,
    root: '/channels',
    section: 'channels',
    depth: 1,
    backTo: toChannels,
  },
  // Projects: one screen per project across its tab routes.
  { pattern: /^\/projects$/, root: '/projects', section: 'projects', depth: 0, contextualList: true },
  {
    pattern: /^\/projects\/([^/]+)(?:\/(?:board|backlog|insights|docs|executors|settings))?$/,
    root: '/projects',
    section: 'projects',
    depth: 1,
    backTo: toProjects,
    identityOf: (match) => `project:${match[1]}`,
    keyScope: () => 'project',
  },
  // Dashboards are Knowledge-section pages: /dashboards is a depth-1 detail
  // whose Back returns to Knowledge, and a dashboard is depth 2 under it.
  {
    pattern: /^\/dashboards$/,
    root: '/knowledge-base',
    section: 'knowledge',
    depth: 1,
    backTo: toKnowledge,
  },
  {
    pattern: /^\/dashboards\/([^/]+)$/,
    root: '/knowledge-base',
    section: 'knowledge',
    depth: 2,
    backTo: toDashboards,
    identityOf: (match) => `dashboard:${match[1]}`,
    keyScope: (identity) => identity,
  },
  // Knowledge: the section root is the space picker; spaces and product
  // views are depth-1 details of it.
  { pattern: /^\/knowledge-base$/, root: '/knowledge-base', section: 'knowledge', depth: 0, contextualList: true },
  {
    pattern: /^\/knowledge-base\/spaces\/([^/]+)$/,
    root: '/knowledge-base',
    section: 'knowledge',
    depth: 1,
    backTo: toKnowledge,
    // A Knowledge space keeps one screen identity across spaces: the mounted
    // workspace swaps its selection rather than remounting the route page.
    identityOf: () => 'space',
    keyScope: () => 'space',
  },
  {
    pattern: /^\/knowledge-base\/views\/([^/]+)$/,
    root: '/knowledge-base',
    section: 'knowledge',
    depth: 1,
    backTo: toKnowledge,
    identityOf: (match) => `view:${match[1]}`,
    keyScope: (identity) => identity,
  },
  { pattern: /^\/settings$/, root: '/settings', section: 'admin', depth: 0, contextualList: true },
  {
    // Search is its own section so its full-page outlet never animates as a
    // channels transition.
    pattern: /^\/search$/,
    root: '/search',
    section: 'search',
    depth: 0,
  },
]

const matchPhoneRoute = (pathname: string): { match: RegExpMatchArray; row: PhoneRouteRow } | null => {
  const normalized = normalizePathname(pathname)
  for (const row of PHONE_ROUTES) {
    const match = normalized.match(row.pattern)
    if (match) return { match, row }
  }
  return null
}

// Phone tab roots (depth 0) are the native tab bar's destinations. Roots
// with a contextual list render that list as the page (and show the Menu
// doorway); /search is a full outlet page. /dashboards is not a tab root —
// it is a Knowledge-section detail that renders its outlet as the page.
export const isPhoneTabRoot = (pathname: string): boolean => {
  const matched = matchPhoneRoute(pathname)
  return matched !== null && matched.row.depth === 0
}

// Does this section's root page render a contextual navigation list (the
// channels/projects/knowledge/admin sidebars)? Search and Dashboards render
// their outlet instead.
export const phoneTabRootHasContextualList = (pathname: string): boolean =>
  matchPhoneRoute(pathname)?.row.contextualList === true

// Which tab a route belongs to. Distinct from isPhoneTabRoot: a tab's detail
// routes also belong to the tab.
export const getPhoneTabRootPath = (pathname: string): string => {
  const matched = matchPhoneRoute(pathname)
  if (matched) return matched.row.root
  if (matchesAdminRoute(normalizePathname(pathname))) return '/settings'
  return '/channels'
}

// Phone navigation is a per-section stack: each tab starts at depth 0 and
// nested routes walk deeper where the UI owns another screen. Project tabs and
// sibling detail selections stay at their current depth, so changing a tab,
// query, entity, or project section does not replay a route-level transition.
// Detail keys are section-scoped where one mounted page swaps its content in
// place — channel A → B, Knowledge space A → B, admin detail A → B.
export const getPhoneNavigationScreen = (
  pathname: string,
): PhoneNavigationScreen | null => {
  const normalized = normalizePathname(pathname)
  const matched = matchPhoneRoute(normalized)
  if (matched) {
    const { match, row } = matched
    if (!row.identityOf || !row.keyScope) {
      return { depth: row.depth, key: `root:${row.section}:${row.root}`, section: row.section }
    }
    return {
      depth: row.depth,
      key: `${row.section}:${row.keyScope(row.identityOf(match))}`,
      section: row.section,
    }
  }
  if (matchesAdminRoute(normalized)) {
    return { depth: 1, key: 'admin:detail', section: 'admin' }
  }
  return null
}

// The shared route-level Back: every phone detail screen returns to its tab
// root with a specific, human-readable label. Tab roots return null (they show
// the Menu doorway instead). This destination is the cold-deep-link fallback;
// the shared Back action pops real history first when the previous in-app
// entry already is this parent.
export const getPhoneNavigationBackTarget = (
  pathname: string,
): PhoneNavigationBackTarget | null => {
  const normalized = normalizePathname(pathname)
  const matched = matchPhoneRoute(normalized)
  if (matched) {
    return matched.row.backTo ? matched.row.backTo(matched.match) : null
  }
  if (matchesAdminRoute(normalized)) {
    return { label: 'Back to Admin', pathname: '/settings' }
  }
  return { label: 'Back to Channels', pathname: '/channels' }
}

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
  if (previousPathname && normalizePathname(previousPathname) === target.pathname) {
    return { mode: 'pop', to: target.pathname }
  }
  return { mode: 'replace', to: target.pathname }
}

// Android hardware Back and the shared in-app Back converge on the same
// semantic target. The native shell never matches routes itself: the page
// reports whether the current route has an in-app parent (depth > 0), and the
// shell consumes the key only then. At a tab root the key falls through to
// the platform default.
export const phoneRouteHasBackDepth = (pathname: string): boolean =>
  getPhoneNavigationBackTarget(pathname) !== null

// A phone Knowledge root is the space picker, not an open space. Retain the
// provider's selection so a detail can restore its workspace, but don't leave
// that prior choice painted as active after Back returns to the picker.
export const shouldHighlightKnowledgeSidebarSelection = (
  pathname: string,
  phoneLayout: boolean,
): boolean => !phoneLayout || normalizePathname(pathname) !== '/knowledge-base'
