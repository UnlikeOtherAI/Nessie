# Deep links, cold starts and screen headers

Chapter of [Navigation — how it is done](overview.md). §8–§9: how a URL opened
from nothing seeds its parent chain, and the one `ScreenHeader` every screen
renders.

## 8. Deep links and cold starts — **built** (step 13)

A cold start — a push notification, an auth return, a pasted link — lands on
a screen with no stack beneath it. **The stack seeds the registry's parent
chain** (`surfaceSeedChain`: `parentOf` up to the section root; a
`parent: 'origin'` row seeds only its root, since its real predecessor is
unknowable) as render-only layers beneath the landed route, so Back and the
edge swipe reveal exactly the screens a real navigation would have. On
`split` only strictly shallower screens are seeded, because a root shares
the floor with its details there.

- Seeded entries **never enter the ledger**: no browser history exists
  behind a cold start, so Back from a seeded stage is always `replace`, and
  the route's own commit refreshes the seeded layer with the real page the
  moment the person arrives on it.
- The shell supplies what a seeded screen shows (`seed` on the viewport): a
  root's page on a phone is the section's list; anything else is rendered
  from the route table for the seeded pathname (`navigation/SeededRoute.tsx`,
  `useRoutes` over the shell route's children) under a location of its own,
  so the page reads the route it stands for. It renders inert until reached.
- **A push that crosses sections seeds its origin.** A channel opened from
  a project, a result opened from Search: the screen the person came from is
  seeded beneath the route instead of the registry's chain, and Back pops to
  it (the control says only "Back"), so the swipe reveals exactly what Back
  lands on. Within a section the declared parent still decides.
- Pinned by `admin/test/cold-start-seeding.test.ts`,
  `admin/test/phone-navigation-stack.test.ts` and
  `admin/test/navigation-layout.test.ts`.

- **The desktop shell has a pending path** like the native one: the Tauri
  init script retains a clicked notification's route on the window before
  it dispatches the open event, and the root redirect replays it once
  (`consumeDesktopPendingPath`), so a click that launched a quit app is no
  longer lost between the dispatch and the subscriber.

**Intent params are declared, not improvised.** A link can carry an
instruction as well as an address — open this document, highlight that
message, accept this call, review this change, announce this checkout. Each
registry row lists what its route reads beyond the path under `intent`
(`page-types.ts` `SurfaceIntent`):

- **`consume`** — a one-shot instruction in the search string (`messageId`,
  `incomingCall`, `acceptCall`, `spaceId`, `pageId`, `connect`, `create`,
  `scopeProjectId`, `uoa_billing`) and **`hash`** — the same in the fragment
  (`#trigger-<id>`, `#confirmationToken=`). A screen reads these only through
  `navigation/intent.ts`: `useConsumedIntent(name)` / `useConsumedIntents(names)`
  / `useConsumedHashIntent(name, parse)` capture the value into component state
  and strip it with **one** replacing redirect (§4's `useRedirect`, so it waits
  for a running slide) — Back and a refresh land on the address, never on the
  instruction. Two hooks on one screen register into one strip, because two
  independent redirects raced: the loser's param survived at a new key and it
  captured the same link twice. Every capture carries a `serial`, so an effect
  keyed on it acts once per link even when the same value arrives twice (two
  pushes for one message). A consumer mounted above the screen that owns the
  intent (the call provider) passes `enabled` and consumes only while the
  screen is the one it belongs to. This replaced six hand-rolled effects — the
  knowledge deep link, the app connect flag, the executors create flag and its
  `hashchange` listener, the trigger anchor, the call and message-highlight
  strips — and the executors page's four `window.history.replaceState` writes,
  which had been changing the address behind the router. A confirmation token
  the page mints itself now lives in state only, so it never enters history or
  a shared address.
- **`state`** — linkable params that describe what the screen shows (`tab`,
  `view`, `filter`, `scope`, `status`, `search`, `query`, `mode`, `parentId`,
  `executorId`, `accessChange`, `promotion`, …). They stay in the URL and read
  through `useTabParam` (§1) or `useSearchParams`, written with `replace`.
- **A name is one or the other on a row, never both.** `?view=` had been
  both: the Knowledge view-mode strip *and* the Integrations page's product
  deep link, so selecting the list view fired the product-view effect, which
  cleared the page path and wiped the tab. The product view is its own route
  (`/knowledge-base/views/:productView`) and the link now uses it.
- **Presence reads the route, never an intent.** `resolvePushSurface` used
  to identify a knowledge space from `?spaceId=`, which the deep link strips
  the moment it opens the page; it reads `/knowledge-base/spaces/:id` now.
- Gate: `admin/test/navigation-intent.test.ts` — every consumed name is
  declared on a row and read nowhere but the hooks; every hook call names a
  declared intent; no `history.replaceState`/`pushState` and no
  `setSearchParams({})` (the whole-set wipe) anywhere in `admin/src`. The same
  file pins the capture, the strip-with-replace, the forwarded state and the
  per-arrival serial against a memory router.

## 9. Screen headers — **built** (step 9)

One header, `admin/src/components/shared/ScreenHeader.tsx`, on every screen.
It replaced `AdminPageHeader`, `MobileSectionHeader` and the hand-rolled hero
and 58 px bars the pages had grown: nine shapes at three heights and seven
title sizes, disagreeing on the doorway, the heading level and whether a
header rendered at all. Five states returned *before* any header — the
`OwnerGate` refusals, the agent-designer loading branch, the dashboard's
loading and not-found branches — so a phone standing on one had no Back.
- **`ScreenHeader` composes `ResponsivePageHeader`, never forks it.** The
  measured leading/actions partition, the overflow-into-More and the popover
  menus stay exactly where they were; `ScreenHeader` adds the leading lane,
  the heading contract, the two slots and the publication.
  `ResponsivePageHeader` gained a `below` slot (the subtitle and tabs live
  inside the one bordered block), a `heading` prop and a `titleId`. It stays
  the primitive for the bars that are **not** a route's screen header — the
  Knowledge panes, which are their own stack layers on `single` and the
  deepest inline pane on `split`, and the workflow toolbar, a panel inside a
  screen that renders `h2` through the same component.
- **The leading lane.** On the `single` layout it is the shared Back doorway,
  `PhoneNavigationButton`, which renders the one Back resolver's answer: an
  open owner, the route's parent, or the menu at a root (§4). On a wide layout
  the shell keeps its pinned sidebar, so a Back paints only where the page
  supplies an `onBack` **and** the registry says the screen has a parent — the
  page-owned "Agents" and "Apps" controls the detail pages already had, moved
  into the lane. A Flow that returns to an address the registry cannot know
  (the designer's edit origin, the compose flow's `returnTo`) declares
  `flowOwnsBack` and owns the control on both layouts; it is still one
  control, never a second doorway beside the shared one.
- **Every screen has exactly one `h1`, and it is the header's title.** The
  settle focuses it and the live region announces it (§12), so a screen with
  no `h1` — or with two, as the Agents root had on a phone — silently loses
  both. `title` is required for that reason. Hero content (an avatar, a status
  line, a description) is the `leading` and `subtitle` slots, and a Tab host's
  strip is the `tabs` slot, which takes the existing `TabBar` element
  unchanged.
- **The header is always rendered.** Loading, empty, not-found and refused
  states render *inside* the screen body under the same header: `OwnerGate`
  now wraps the body, not the page (Audit Log, Policy, Operational usage), and
  the agent, app and dashboard details render their header on every branch.
- **The header names the screen everywhere.** The registry classifies a route
  but cannot name it, so the rendered title is published to
  `navigation/screen.ts`, keyed by the pathname of the layer that rendered it
  — retained and seeded layers stay mounted under their own location, so
  several headers publish at once and the shell reads the one for the live
  route. `applyScreen` then does the two things outside the document together,
  so the browser tab and the native chrome can never disagree:
  `document.title` becomes `<screen title> · Nessie` (an unpublished screen
  keeps `Nessie` alone rather than a leading separator), and the native shell
  receives `nessie:screen` (§10).
- **The header is this framework's; the body below it is the content kit's.**
  A page is one `ScreenHeader` over the content system's own components —
  `PageBody`/`Section`, `RowList`, `QueryState`, `PaginationFooter`,
  `DataTable`, the `FormField`/`FormControls`/`FormActions` family
  ([plans/2026-09-01-content-design-system/overview.md](../plans/2026-09-01-content-design-system/overview.md)).
  Neither owns the other: a body component never paints a *page* header or a
  second `h1` (a card's own `<header>` heading row is sectioning content, not
  a screen header), and the header never lays out content. Where a screen's
  loading state is a skeleton frame rather than a sentence (§14), it keeps
  that markup and `QueryState` is left with the error and empty lines it
  exists for.
- Pinned by `admin/test/screen-header.test.ts`: the SSR shape (one `h1`, the
  doorway at a screen with a parent and the menu at a root, the optional
  slots), `document.title`, the posted message's six fields, and the source
  gates — `AdminPageHeader` and `MobileSectionHeader` do not exist, nothing
  imports or renders them, and no file under `admin/src/pages/**` paints a
  `<header>` of its own.

