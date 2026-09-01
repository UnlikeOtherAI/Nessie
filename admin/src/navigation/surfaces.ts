// The surface registry: one declarative table that classifies every route in
// `admin/src/router.tsx`. It is the single source of truth for what kind of
// screen a route is, which section owns it, how deep it sits in that
// section's stack, which screens are the *same* screen (so a sibling swap
// never animates), and which screen a route's Back returns to.
//
// It is **total**. There is no catch-all row and no fallback classification:
// a path either matches a row here or it is one of the handful of screens
// that live outside the navigation stack (`OUTSIDE_STACK_PATHS`). That
// totality is enforced twice — `admin/test/navigation-surfaces-total.test.ts`
// and `scripts/lint-navigation-surfaces.mjs` both read `router.tsx` and
// assert every path it declares resolves here. Adding a route without adding
// its row fails the lint, which is the point: the old `admin:detail`
// catch-all silently flattened the whole Agents and Settings families onto
// one screen, so none of their pushes animated and none of their Backs knew
// where to return.
//
// The page-type vocabulary a row is written in lives beside this table, in
// `page-types.ts`. Rulebook: `docs/navigation.md`. Plan: step 3 of
// `docs/plans/2026-09-01-navigation-motion-system.md` (§4.1).

import type { NavigationLayout } from './layout'
import type { Surface, SurfaceParent, SurfaceScreen } from './page-types'


// Strip query/hash and trailing slashes so route-family checks compare the
// semantic pathname only: `/channels?filter=unread` is the Channels root.
export const normalizeNavigationPathname = (pathname: string): string => {
  const normalized = (pathname.split(/[?#]/, 1)[0] ?? '/').replace(/\/+$/, '')
  return normalized || '/'
}

const CHANNELS_ROOT = '/channels'
const PROJECTS_ROOT = '/projects'
const KNOWLEDGE_ROOT = '/knowledge-base'
const ADMIN_ROOT = '/settings'
const SEARCH_ROOT = '/search'

const toChannels = (): SurfaceParent => ({ label: 'Back to Channels', pathname: CHANNELS_ROOT })
const toProjects = (): SurfaceParent => ({ label: 'Back to Projects', pathname: PROJECTS_ROOT })
const toKnowledge = (): SurfaceParent => ({ label: 'Back to Knowledge', pathname: KNOWLEDGE_ROOT })
const toDashboards = (): SurfaceParent => ({ label: 'Back to Dashboards', pathname: '/dashboards' })
const toAdmin = (): SurfaceParent => ({ label: 'Back to Admin', pathname: ADMIN_ROOT })
const toApps = (): SurfaceParent => ({ label: 'Apps', pathname: '/apps' })
const toAgents = (): SurfaceParent => ({ label: 'Back to Agents', pathname: '/agents' })
const toWorkflows = (): SurfaceParent => ({ label: 'Back to Workflows', pathname: '/agents/workflows' })
const toStatuses = (): SurfaceParent => ({ label: 'Back to Statuses', pathname: '/settings/statuses' })

// A route that only forwards to another one. It renders no screen, so it
// declares nothing but its section — enough for the tab bar to stay lit for
// the frame it exists.
// Takes a named row rather than positional arguments so every `pattern:` in
// this file reads the same way — the totality lint extracts them textually.
const redirect = (row: Pick<Surface, 'pattern' | 'root' | 'section'>): Surface => ({
  depth: 0,
  ...row,
  type: 'redirect',
})

// First match wins, so the order inside each section is specific → generic.
export const SURFACES: Surface[] = [
  // ── Redirects ────────────────────────────────────────────────────────────
  // Listed first: several would otherwise be captured by a generic pattern
  // below (`/settings/tools` and `/settings/agents` by the settings-page row).
  redirect({ pattern: /^\/$/, root: CHANNELS_ROOT, section: 'channels' }),
  redirect({ pattern: /^\/chats$/, root: CHANNELS_ROOT, section: 'channels' }),
  redirect({ pattern: /^\/work$/, root: PROJECTS_ROOT, section: 'projects' }),
  redirect({ pattern: /^\/workflows$/, root: ADMIN_ROOT, section: 'admin' }),
  redirect({ pattern: /^\/workflows\/tools$/, root: ADMIN_ROOT, section: 'admin' }),
  redirect({ pattern: /^\/settings\/tools$/, root: ADMIN_ROOT, section: 'admin' }),
  redirect({ pattern: /^\/settings\/agents$/, root: ADMIN_ROOT, section: 'admin' }),
  redirect({ pattern: /^\/integrations$/, root: ADMIN_ROOT, section: 'admin' }),

  // ── Channels ─────────────────────────────────────────────────────────────
  {
    contextualList: true,
    depth: 0,
    pattern: /^\/channels$/,
    root: CHANNELS_ROOT,
    section: 'channels',
    type: 'root',
  },
  {
    // Compose is a Flow over the Channels root, not a conversation: it keeps
    // its own identity so switching from a conversation to it swaps in place,
    // while opening it from the root pushes. Listed before the conversation
    // row, which would otherwise swallow `/channels/new` as a channel id.
    depth: 1,
    flowPresentation: 'screen',
    identityOf: () => 'compose',
    keyScope: () => 'compose',
    parentOf: toChannels,
    pattern: /^\/channels\/new$/,
    root: CHANNELS_ROOT,
    section: 'channels',
    type: 'flow',
  },
  {
    depth: 1,
    identityOf: (match) => `project:${match[1]}`,
    keyScope: () => 'projects',
    parentOf: toChannels,
    pattern: /^\/channels\/projects\/([^/]+)$/,
    root: CHANNELS_ROOT,
    section: 'channels',
    type: 'detail',
  },
  {
    depth: 4,
    identityOf: (match) => `channel:${match[1]}`,
    keyScope: () => 'channel',
    parentOf: (match) => ({
      label: 'Back to members',
      pathname: `/channels/${match[1]}/info/members`,
    }),
    pattern: /^\/channels\/([^/]+)\/info\/members\/add$/,
    root: CHANNELS_ROOT,
    section: 'channels',
    splitInline: true,
    type: 'nested',
  },
  {
    depth: 3,
    identityOf: (match) => `channel:${match[1]}`,
    keyScope: () => 'channel',
    parentOf: (match) => ({
      label: 'Back to channel info',
      pathname: `/channels/${match[1]}/info`,
    }),
    pattern: /^\/channels\/([^/]+)\/info\/members$/,
    root: CHANNELS_ROOT,
    section: 'channels',
    splitInline: true,
    type: 'nested',
  },
  {
    depth: 2,
    identityOf: (match) => `channel:${match[1]}`,
    keyScope: () => 'channel',
    parentOf: (match) => ({
      label: 'Back to conversation',
      pathname: `/channels/${match[1]}`,
    }),
    pattern: /^\/channels\/([^/]+)\/info$/,
    root: CHANNELS_ROOT,
    section: 'channels',
    splitInline: true,
    type: 'nested',
  },
  {
    // A reply thread is a full phone screen over its conversation, so the
    // retained conversation slides back into view when it closes.
    depth: 2,
    identityOf: (match) => `channel:${match[1]}`,
    keyScope: () => 'channel',
    parentOf: (match) => ({
      label: 'Back to conversation',
      pathname: `/channels/${match[1]}`,
    }),
    pattern: /^\/channels\/([^/]+)\/threads\/([^/]+)\/replies\/([^/]+)$/,
    root: CHANNELS_ROOT,
    section: 'channels',
    splitInline: true,
    type: 'nested',
  },
  {
    // The conversation. Its Messages / Files / Automations / Agents strip is
    // component state, not routes, so there is nothing to classify beneath it.
    depth: 1,
    identityOf: (match) => `channel:${match[1]}`,
    keyScope: () => 'channel',
    parentOf: toChannels,
    pattern: /^\/channels\/([^/]+)(?:\/.*)?$/,
    root: CHANNELS_ROOT,
    section: 'channels',
    type: 'detail',
  },
  {
    // The Threads inbox and the unread list are Channels-section lists, one
    // step in from the root — not tab roots of their own.
    depth: 1,
    parentOf: toChannels,
    pattern: /^\/(?:threads|unread-messages)$/,
    root: CHANNELS_ROOT,
    section: 'channels',
    type: 'detail',
  },

  // ── Projects ─────────────────────────────────────────────────────────────
  {
    contextualList: true,
    depth: 0,
    pattern: /^\/projects$/,
    root: PROJECTS_ROOT,
    section: 'projects',
    type: 'root',
  },
  {
    // The project's seven section paths are one tab host on one identity:
    // switching sections swaps content in place and never animates, even
    // though each section is its own route.
    depth: 1,
    identityOf: (match) => `project:${match[1]}`,
    keyScope: () => 'project',
    parentOf: toProjects,
    pattern: /^\/projects\/([^/]+)(?:\/(?:board|backlog|insights|docs|executors|settings))?$/,
    root: PROJECTS_ROOT,
    section: 'projects',
    type: 'tabHost',
  },

  // ── Knowledge ────────────────────────────────────────────────────────────
  {
    contextualList: true,
    depth: 0,
    pattern: /^\/knowledge-base$/,
    root: KNOWLEDGE_ROOT,
    section: 'knowledge',
    type: 'root',
  },
  {
    // A Knowledge space keeps one screen identity across spaces: the mounted
    // workspace swaps its selection rather than remounting the route page.
    depth: 1,
    identityOf: () => 'space',
    keyScope: () => 'space',
    parentOf: toKnowledge,
    pattern: /^\/knowledge-base\/spaces\/([^/]+)$/,
    root: KNOWLEDGE_ROOT,
    section: 'knowledge',
    type: 'detail',
  },
  {
    depth: 1,
    identityOf: (match) => `view:${match[1]}`,
    keyScope: (identity) => identity,
    parentOf: toKnowledge,
    pattern: /^\/knowledge-base\/views\/([^/]+)$/,
    root: KNOWLEDGE_ROOT,
    section: 'knowledge',
    type: 'detail',
  },
  {
    depth: 1,
    parentOf: toKnowledge,
    pattern: /^\/dashboards$/,
    root: KNOWLEDGE_ROOT,
    section: 'knowledge',
    type: 'detail',
  },
  {
    depth: 2,
    identityOf: (match) => `dashboard:${match[1]}`,
    keyScope: (identity) => identity,
    parentOf: toDashboards,
    pattern: /^\/dashboards\/([^/]+)$/,
    root: KNOWLEDGE_ROOT,
    section: 'knowledge',
    type: 'nested',
  },

  // ── Admin ────────────────────────────────────────────────────────────────
  {
    contextualList: true,
    depth: 0,
    pattern: /^\/settings$/,
    root: ADMIN_ROOT,
    section: 'admin',
    type: 'root',
  },
  {
    depth: 2,
    identityOf: (match) => `status:${match[1]}`,
    keyScope: () => 'status',
    parentOf: toStatuses,
    pattern: /^\/settings\/statuses\/([^/]+)$/,
    root: ADMIN_ROOT,
    section: 'admin',
    splitInline: true,
    type: 'nested',
  },
  {
    // Every settings page: profile, security, secrets, organization,
    // statuses, notifications, connections, integrations, appearance,
    // members, push. They share one screen identity, so page A → page B
    // swaps in place exactly as it does today.
    depth: 1,
    parentOf: toAdmin,
    pattern: /^\/settings\/([^/]+)$/,
    root: ADMIN_ROOT,
    section: 'admin',
    type: 'detail',
  },
  {
    depth: 1,
    parentOf: toAdmin,
    pattern: /^\/agents$/,
    root: ADMIN_ROOT,
    section: 'admin',
    type: 'detail',
  },
  {
    depth: 2,
    flowPresentation: 'screen',
    identityOf: (match) => `designer:${match[1] ?? 'new'}`,
    keyScope: () => 'agent-designer',
    parentOf: toAgents,
    pattern: /^\/agents\/designer(?:\/([^/]+))?$/,
    root: ADMIN_ROOT,
    section: 'admin',
    type: 'flow',
  },
  {
    depth: 2,
    flowPresentation: 'screen',
    identityOf: (match) => `workflow-designer:${match[1] ?? 'new'}`,
    keyScope: () => 'workflow-designer',
    parentOf: toWorkflows,
    pattern: /^\/agents\/workflow-designer(?:\/([^/]+))?$/,
    root: ADMIN_ROOT,
    section: 'admin',
    type: 'flow',
  },
  {
    // The automation browsers. Their column stages are state, not routes;
    // they become nested stages in step 6.
    depth: 1,
    parentOf: toAdmin,
    pattern: /^\/agents\/(?:workflows|triggers|tools|executors)$/,
    root: ADMIN_ROOT,
    section: 'admin',
    type: 'detail',
  },
  {
    // Dynamic agent id last, mirroring the router's own ranking. A sub-agent
    // drill-in is the same screen identity, so it swaps in place; Back
    // returns to the Agents list.
    depth: 2,
    identityOf: (match) => `agent:${match[1]}`,
    keyScope: () => 'agent',
    parentOf: toAgents,
    pattern: /^\/agents\/([^/]+)$/,
    root: ADMIN_ROOT,
    section: 'admin',
    type: 'detail',
  },
  {
    depth: 1,
    parentOf: toAdmin,
    pattern: /^\/apps$/,
    root: ADMIN_ROOT,
    section: 'admin',
    type: 'detail',
  },
  {
    depth: 2,
    identityOf: (match) => `app:${match[1]}`,
    keyScope: () => 'app',
    parentOf: toApps,
    pattern: /^\/apps\/([^/]+)$/,
    root: ADMIN_ROOT,
    section: 'admin',
    type: 'nested',
  },
  {
    // Governance and billing pages sit beside the settings pages, one step in
    // from the Admin root.
    depth: 1,
    parentOf: toAdmin,
    pattern: /^\/(?:audit|approvals|tokens|policy)$/,
    root: ADMIN_ROOT,
    section: 'admin',
    type: 'detail',
  },
  {
    // Reached from the bell, the account menu and push notifications, from
    // any section — so Back returns to where the reader actually was, and
    // falls back to Admin (where both are listed) on a cold deep link.
    depth: 1,
    parent: 'origin',
    parentOf: toAdmin,
    pattern: /^\/(?:alerts|feedback)$/,
    root: ADMIN_ROOT,
    section: 'admin',
    type: 'detail',
  },
  {
    depth: 1,
    parentOf: toAdmin,
    pattern: /^\/ops$/,
    root: ADMIN_ROOT,
    section: 'admin',
    type: 'detail',
  },
  {
    // Owner-only, listed on the Admin sidebar; `/ops` is super-admin-only
    // and does not link here. Back pops to wherever the reader came from
    // (Admin, or `/ops` for a super-admin) and falls back to Admin on a cold
    // link — never to a page the owner cannot open.
    depth: 2,
    parent: 'origin',
    parentOf: toAdmin,
    pattern: /^\/ops\/usage$/,
    root: ADMIN_ROOT,
    section: 'admin',
    type: 'nested',
  },

  // ── Search ───────────────────────────────────────────────────────────────
  {
    // Its own section so its full-page outlet never animates as a Channels
    // transition. It renders the outlet, not a contextual list.
    depth: 0,
    pattern: /^\/search$/,
    root: SEARCH_ROOT,
    section: 'search',
    type: 'root',
  },
]

// The screens that are deliberately outside the navigation stack (plan §5,
// "Outside"): unauthenticated entry points and the not-found catch-all. They
// render without the shell, so they have no section, no depth and no Back.
// The totality gate reads this list rather than keeping its own copy.
export const OUTSIDE_STACK_PATHS = ['/bootstrap', '/login', '/login/completing', '*']

export type SurfaceMatch = {
  match: RegExpMatchArray
  surface: Surface
}

export const matchSurface = (pathname: string): SurfaceMatch | null => {
  const normalized = normalizeNavigationPathname(pathname)
  for (const surface of SURFACES) {
    const match = normalized.match(surface.pattern)
    if (match) return { match, surface }
  }
  return null
}

// The screen a route renders, or null when it renders none: a redirect
// forwards without ever painting a stage, and an unknown path is not a
// screen at all (the gates make an unknown path impossible for a real route).
//
// The layout changes two things (docs/navigation.md §5). On `split` the
// section's list is the pinned column, not a screen, so a root and its
// details share the stack floor (depth 1): a root → detail is an in-place
// swap with nothing retained beneath, while a detail → nested still pushes
// inside the column. And a `splitInline` nested row classifies as its
// parent's screen there, because its parent's page renders it itself.
export const surfaceScreen = (
  pathname: string,
  layout: NavigationLayout = 'single',
): SurfaceScreen | null => {
  const matched = matchSurface(pathname)
  if (!matched || matched.surface.type === 'redirect') return null
  const { match, surface } = matched
  if (layout === 'split' && surface.splitInline && surface.parentOf) {
    return surfaceScreen(surface.parentOf(match).pathname, layout)
  }
  const depth = layout === 'split' ? Math.max(surface.depth, 1) : surface.depth
  if (!surface.identityOf || !surface.keyScope) {
    return {
      depth,
      key: `root:${surface.section}:${surface.root}`,
      section: surface.section,
    }
  }
  return {
    depth,
    key: `${surface.section}:${surface.keyScope(surface.identityOf(match))}`,
    section: surface.section,
  }
}

// The deterministic parent screen of a route: what Back returns to on a cold
// deep link, and the label the Back control announces. Roots and redirects
// have none.
export const surfaceParent = (pathname: string): SurfaceParent | null => {
  const matched = matchSurface(pathname)
  if (!matched || matched.surface.type === 'redirect') return null
  return matched.surface.parentOf ? matched.surface.parentOf(matched.match) : null
}

// Which section (tab) owns a route. Unknown paths fall back to Channels, the
// first tab, so the tab bar always has one lit item.
export const surfaceRootPath = (pathname: string): string =>
  matchSurface(pathname)?.surface.root ?? CHANNELS_ROOT
