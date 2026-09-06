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
// `page-types.ts`. Rulebook: `docs/navigation/overview.md`. Plan: step 3 of
// `docs/done/2026-09-01-navigation-motion-system.md` (§4.1).

import type { Surface, SurfaceIntent } from './page-types'
import { createAdminSurfaces } from './admin-surfaces'
import { createConnectedMailSurfaces } from './connected-mail-surfaces'
import {
  toChannels,
  toDashboards,
  toKnowledge,
  toProjects,
} from './surface-parents'


// Strip query/hash and trailing slashes so route-family checks compare the
// semantic pathname only: `/channels?filter=unread` is the Channels root.
export const normalizeNavigationPathname = (pathname: string): string => {
  const normalized = (pathname.split(/[?#]/, 1)[0] ?? '/').replace(/\/+$/, '')
  return normalized || '/'
}

export const CHANNELS_ROOT = '/channels'
const PROJECTS_ROOT = '/projects'
const KNOWLEDGE_ROOT = '/knowledge-base'
const ADMIN_ROOT = '/settings'
const SEARCH_ROOT = '/search'

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
// The knowledge team is one component parameterised by scope (the
// section and a project's Docs tab), so its intent is one object too:
// `?spaceId=&pageId=` opens a document from an approval, a search result or
// a research run, and `?view=` is the view-mode strip.
const KNOWLEDGE_INTENT: SurfaceIntent = {
  consume: ['spaceId', 'pageId'],
  state: ['view'],
}

/**
 * The project tab host consumes the knowledge intents its Docs section reads,
 * plus the two doorways into its Settings section: `create` opens the new-board
 * dialog, `connect` opens the source picker. Both say what to open on arrival
 * rather than what the page durably is, which is what makes them intents.
 */
const PROJECT_INTENT: SurfaceIntent = {
  consume: [...KNOWLEDGE_INTENT.consume ?? [], 'create', 'connect'],
  state: [...KNOWLEDGE_INTENT.state ?? [], 'board', 'section', 'source'],
}

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

  // ── Connected mail ───────────────────────────────────────────────────────
  ...createConnectedMailSurfaces(ADMIN_ROOT),

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
    // It fills the viewport: a fixed header and bottom-anchored composer with a
    // scrolling feed between them, so on `single` its page shell must be a
    // non-scrolling flex column rather than the block scroller (see
    // `fillsViewport`).
    depth: 1,
    fillsViewport: true,
    identityOf: (match) => `channel:${match[1]}`,
    keyScope: () => 'channel',
    intent: {
      consume: ['messageId', 'incomingCall', 'acceptCall'],
      state: ['tab', 'research'],
    },
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
    intent: PROJECT_INTENT,
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
    intent: KNOWLEDGE_INTENT,
    pattern: /^\/knowledge-base$/,
    root: KNOWLEDGE_ROOT,
    section: 'knowledge',
    type: 'root',
  },
  {
    // A Knowledge space keeps one screen identity across spaces: the mounted
    // team swaps its selection rather than remounting the route page.
    depth: 1,
    identityOf: () => 'space',
    keyScope: () => 'space',
    intent: KNOWLEDGE_INTENT,
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
    intent: KNOWLEDGE_INTENT,
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
  ...createAdminSurfaces(ADMIN_ROOT),

  // ── Search ───────────────────────────────────────────────────────────────
  {
    // Its own section so its full-page outlet never animates as a Channels
    // transition. It renders the outlet, not a contextual list.
    depth: 0,
    intent: { state: ['query', 'mode'] },
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
