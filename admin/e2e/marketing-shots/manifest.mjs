// One entry per image slot on nessie.works, in the order the page uses them.
//
// The website has fifteen slots and, before this, three files rotated through
// all of them (docs/plans/2026-09-14-marketing-site-handover.md, open item 1).
// Each entry below names the row it serves and the claim that row makes, so
// that changing the copy and changing the picture stay one decision.
//
// Two kinds:
//
// - `window` — the three hero shots. They are painted into the 3D iMac's
//   screen texture (`web/src/home/desktop3d.tsx`), so they are whole-window,
//   opaque and 16:10. The bezel does the rounding; do not round these.
// - `element` — the twelve pillar rows. Cut out of the running admin with the
//   radius and the shadow in the file's alpha channel, because those rows sit
//   on white in some sections and on navy in others.
//
// `ready` is the thing the shot is *about*. Waiting for it rather than for a
// timeout is what stops a green run from producing a picture of a spinner.
// `open` names a tab to click first, for a surface that is a tab rather than
// a route. `inset` adds padding inside the rounded edge, for a section whose
// own heading sits in the corner the radius cuts away.
//
// `theme` is the admin palette the shot is taken in. Everything defaults to
// `nessie`, the product's own default — the blue one — so the website shows
// people what they will actually see the first time they sign in. The three
// hero shots deliberately differ: the desktop in the hero is a thing you can
// recolour, and showing one screen in three palettes says that better than a
// sentence would.
import { IDS } from './fixture.mjs'

const channel = (id) => `/channels/${id}`

/**
 * Admin palettes, by the name the product uses for them.
 *
 * `nessie` is the default and is blue. `nebula` carries the label "Classic" in
 * the theme picker and is the warm palette Nessie shipped with — it has no
 * `[data-theme]` block of its own because it *is* the base `:root` palette.
 */
export const THEMES = { blue: 'nessie', classic: 'nebula', sunstone: 'sandstone' }

/** The desktop the hero's iMac screen shows: 16:10, matching the old assets. */
export const HERO_VIEWPORT = { height: 900, width: 1440 }

/** Roomy enough that a cut-out element plus its shadow margin always fits. */
export const CUT_VIEWPORT = { height: 1000, width: 1440 }

export const shots = [
  // ---------------------------------------------------------------- hero ---
  {
    claim: 'Brief a teammate — a person hands work to an agent by name.',
    kind: 'window',
    name: 'hero-brief',
    ready: 'text=Waverley have asked for a renewal quote',
    route: () => channel(IDS.salesChannel),
    theme: THEMES.blue,
    viewport: HERO_VIEWPORT,
  },
  {
    claim: 'It gets it done — two agents settle it between them.',
    kind: 'window',
    name: 'hero-handoff',
    ready: 'text=Handing the revenue check',
    route: () => channel(IDS.opsChannel),
    theme: THEMES.sunstone,
    viewport: HERO_VIEWPORT,
  },
  {
    claim: 'The whole team, and the agents each person runs.',
    kind: 'window',
    // Deliberately not the mailbox, which is the obvious third hero: the
    // filter strip above its conversation list renders metres tall
    // (`.tabbar-shell-full { flex: 1 1 auto }` grows along a *column's* main
    // axis). Put the mailbox back here once that is fixed — a re-run picks it
    // up with no other change.
    name: 'hero-team',
    ready: 'text=Klára Benešová',
    route: () => '/settings/members',
    theme: THEMES.classic,
    viewport: HERO_VIEWPORT,
  },

  // ------------------------------------------------- pillar: AI employees ---
  {
    claim: 'A colleague, not a chatbot — a name, a role and an owner.',
    kind: 'element',
    name: 'teammates-colleague',
    ready: 'text=Customer Support',
    route: () => '/settings/members',
    // The left column only: the right one is an "add member" form with a
    // password field in it, which is not what this row is about.
    inset: 18,
    selector: 'section.grid:has(.admin-card)',
    viewport: CUT_VIEWPORT,
  },
  {
    claim: 'An inbox of its own — customers write to the agent directly.',
    kind: 'element',
    name: 'teammates-inbox',
    ready: 'text=Renewal quote for Waverley',
    route: () => `/agents/${IDS.mia}/mailbox`,
    // The reading pane, not the whole workspace: the workspace carries the
    // over-tall filter strip described on `hero-team`.
    selector: '[data-testid="mailbox-reading-pane"]',
    // Short on purpose: the pane stretches to the viewport, so a tall window
    // cuts out as a short letter above a metre of empty paper.
    viewport: { height: 700, width: 1440 },
  },
  {
    claim: 'Knows only what it should — it is in the rooms it was given, and no others.',
    kind: 'element',
    name: 'teammates-scope',
    // `/settings/agent-access` redirects to paired agents, which is the
    // opposite capability (publishing Nessie to other tools). The screen that
    // actually shows an agent's reach is the channel's own agent panel: Mia
    // and Leo are in this room, Ada is not.
    open: 'Agents',
    ready: 'text=Customers',
    route: () => channel(IDS.salesChannel),
    selector: '[data-testid="channel-agents-panel"]',
    viewport: CUT_VIEWPORT,
  },

  // ----------------------------------------------------- pillar: Teamwork ---
  {
    claim: 'Handoffs without meetings — one thread, three agents, every step.',
    kind: 'element',
    name: 'teamwork-handoff',
    ready: 'text=Taking it back',
    route: () => channel(IDS.opsChannel),
    selector: '.admin-chat-feed',
    viewport: CUT_VIEWPORT,
  },
  {
    claim: 'People and agents in one conversation.',
    kind: 'element',
    name: 'teamwork-together',
    ready: 'text=Reading it now',
    route: () => channel(IDS.salesChannel),
    selector: '.admin-chat-feed',
    viewport: CUT_VIEWPORT,
  },
  {
    claim: 'Always on — schedules that run with nobody on call.',
    kind: 'element',
    name: 'teamwork-always-on',
    ready: 'text=Month-end close',
    route: () => '/agents/triggers',
    selector: 'ul[aria-label="Triggers"]',
    viewport: CUT_VIEWPORT,
  },

  // --------------------------------------------------- pillar: Your people ---
  {
    claim: 'More time with customers — the agent stops and waits for a person.',
    kind: 'element',
    name: 'people-customers',
    ready: '[aria-label="Pending approvals"]',
    route: () => '/approvals',
    selector: '[aria-label="Pending approvals"]',
    viewport: CUT_VIEWPORT,
  },
  {
    claim: 'Room for creative work — the reading was done before you opened it.',
    kind: 'element',
    name: 'people-creative',
    // Opening the page is component state, not a route, so the shot clicks it.
    open: 'Waverley',
    ready: 'text=Waverley',
    route: () => '/knowledge-base',
    selector: '.kb-reader',
    viewport: { height: 1100, width: 1560 },
  },
  {
    claim: 'Every person leads a team — one person, several agents of their own.',
    kind: 'element',
    name: 'people-leads',
    // The agents table, not the roster: `teammates-colleague` already shows
    // the roster, and no two rows on the page should be the same picture.
    // This one is the same fact from the agents' side — every agent with the
    // person answerable for it.
    ready: 'text=Ada Lindqvist',
    route: () => '/agents',
    selector: '.admin-expandable-table',
    viewport: { height: 1100, width: 1560 },
  },

  // ------------------------------------------------------ pillar: Control ---
  {
    claim: 'Run it where your data should live — your organisation, your settings.',
    kind: 'element',
    name: 'control-host',
    ready: 'text=Northwind',
    route: () => '/settings/organization',
    // The cards, not the page: `main section` is the full-height scroll
    // container and cuts out as a tall empty rectangle.
    selector: 'main .grid:has(> section.admin-card)',
    viewport: { height: 1100, width: 1560 },
  },
  // The fourth Control row, "Sign in through your own SSO", has no shot.
  // A local fixture has no identity provider, so the sign-in screen says "No
  // sign-in providers are configured" — the one thing that row must not show.
  // It needs a capture run against a UOA-configured instance, or copy that
  // matches a screen this fixture can actually produce.
  {
    claim: 'Know what every agent did — an audit trail that names the actor.',
    kind: 'element',
    name: 'control-audit',
    ready: 'text=email.send',
    route: () => '/audit',
    selector: 'ul[aria-label="Audit events"]',
    viewport: CUT_VIEWPORT,
  },
]
