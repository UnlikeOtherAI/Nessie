# One navigation framework — census, page types, and refactor plan

**Status:** proposal, 2026-09-01. Nothing here is built yet.
**Trigger:** on the iPhone shell, tapping a channel slides the conversation in,
overshoots to the left (the avatars touch the screen edge, the Back chevron is
clipped), then springs back to rest. The investigation widened into a full
census of how the admin moves between screens, and the answer is a framework,
not a motion patch.

**Decisions this plan is built on:**

1. Consistency is the goal. Every move between two stages of the admin goes
   through one system, on phone, tablet, desktop and the native shells.
2. Animations stay, and on mobile they are the primary target. Every push and
   pop slides. The one thing that never slides is an in-page tab switch.
3. Page types are a closed set. Every screen is exactly one type, and the type
   decides its container, its motion, and its Back rule. A screen that needs a
   seventh type is a design defect to fix, not a case to special-case.

## 1. The bounce — root cause

The push itself cannot overshoot: `.phone-navigation-screen` animates
`translate3d(100%) → 0` with `cubic-bezier(0.22, 1, 0.36, 1)`, whose control
points never leave the 0–1 range. The motion census (§2.1) confirms **no easing
anywhere in the admin overshoots**. The bounce is a **stale horizontal scroll
offset on the `overflow: hidden` viewport** that the compositor keeps applying
after the transform has reached zero.

Sequence, all in `PhoneNavigationViewport.tsx`:

1. A forward push mounts the destination in the `--forward-ready` pose,
   `translate3d(100%, 0, 0)`, so the browser paints its DOM once before motion
   starts. During that commit the destination's descendants run their layout
   effects.
2. `components/primitives/TabBar.tsx:83` runs
   `scrollIntoView({ block: 'nearest', inline: 'nearest' })` on its selected
   item in a `useLayoutEffect`. The channel screen contains the Messages /
   Files / Automations / Agents `TabBar`, so this fires while the screen sits
   one viewport-width to the right.
3. `scrollIntoView` scrolls **every** scrollable ancestor. `overflow: hidden`
   boxes are scroll containers — they hide the bars but accept programmatic
   scrolling — and a transformed child extends its parent's scrollable
   overflow. The `.phone-navigation-viewport` acquires a positive `scrollLeft`
   (114 px in the reproduction).
4. The transform animation runs on the compositor. The main thread only
   re-clamps `scrollLeft` when something forces layout — a React commit for
   the loading feed, `useStickToBottom`'s ResizeObserver, a query resolving.
   Each clamp leaves whatever residue the transform still had at that moment.
5. The compositor carries the transform to 0 with that residue still
   subtracted, so the screen lands **left of rest by the residue**. The next
   layout (`finishTransition` swapping the class to `--current`) clamps
   `scrollLeft` to 0 and the screen snaps back. A ~8 pt residue matches the
   screenshot.

Reproduction (`2026-09-01-navigation-motion-system/repro.html` + `repro.mjs`,
Playwright Chromium, 393 px viewport, the viewport CSS copied verbatim, 3 s
animation so a layout flush can be placed):

| scenario | `scrollLeft` after mount | after a mid-animation layout flush |
| --- | --- | --- |
| `overflow: hidden` + TabBar `scrollIntoView` | 114 px | 33 px at 40 %, 7 px at 60 % |
| `overflow: hidden`, no `scrollIntoView` | 0 | 0 |
| `overflow: clip` + TabBar `scrollIntoView` | 0 | 0 |

Headless screenshots flush layout before capture, so the visual half only shows
on device. The same defect class exists wherever a screen slides inside a
hidden-overflow box: `ColumnBrowserViewport` wraps its track in
`overflow-hidden` and its columns mount `TabBar`s too, and every `autoFocus` or
`.focus()` without `preventScroll` on a mounting screen triggers it
(`DesignerChat.tsx:61` fires on mount; `ConversationInfoFlow`,
`ChannelSearchPanel`, `SearchPage`, `ChannelConversationComposePage`,
`MemberManagementPopup` carry `autoFocus`).

**Fix, structural:** stack containers are `overflow: clip`, which is by
definition not a scroll container, so no descendant can scroll them whatever
it calls. Supported from Safari / iOS 16, Chrome 90, Firefox 81 (MDN
browser-compat-data); the app targets iOS 16.0. `TabBar` scrolls only its own
track. Focus on a mounting screen waits for the stack to settle (§4.7).

## 2. Census — what exists today

Thirteen sweeps covered every page, every overlay, every tab strip, the shell
chrome, the native shell, every navigation call site, all motion CSS, and the
tests and specs that pin behaviour. Totals:

| area | stages | with any motion | notes |
| --- | --- | --- | --- |
| Channels (incl. threads, search, compose) | 49 | 2 | route push on phone + nav drawer |
| Projects + Dashboards | 54 | 3 | route push, Knowledge fade, drawer |
| Knowledge (routes + provider state) | 23 + 3 reuse sites | 2 | fade-slide on remount, attachments drawer |
| Agents, designers, workflows, triggers, tools, executors, apps | 93 | 3 | column track, drawer, `/apps` push |
| Settings, governance, ops, feedback | 60 | 3 | nav drawer, workspace menu, column track |
| Overlays repo-wide | 50 (32 dialogs, 8 drawers, 9 popovers, 1 search) | 5 | none register with Back |
| In-page tab / view-mode switches | 15 | pill only | three different state models |
| Navigation triggers | 214 in 118 files | — | 20 `<Navigate>`, 11 `setSearchParams`, 8 hard reloads |

### 2.1 Five motion vocabularies, none tokenised

| # | mechanism | motion | direction | gesture | reduced motion |
| --- | --- | --- | --- | --- | --- |
| 1 | Phone route stack (`PhoneNavigationViewport` + matrix + ledger + swipe) | CSS keyframes 300 ms `cubic-bezier(0.22,1,0.36,1)`, 28 % parallax | route depth | edge swipe, WAAPI settle **220 ms** | skips |
| 2 | `ColumnBrowserViewport` (Workflows, Tools, Integrations, Triggers) | Tailwind `transition-transform duration-300 ease-out` | column index | none | compressed |
| 3 | `animate-kb-view-slide` (Knowledge, project Docs, agent Documents) | 220 ms fade + 18 px slide, on remount only | none | none | compressed |
| 4 | Drawers (`MobileNavDrawer` 200 ms, `AttachmentsDrawer` 300 ms, `WorkspaceMenu` 150 ms) | Tailwind transitions | open flag | none | 2 of 8 |
| 5 | Nothing | tablet/desktop detail column, `Dialog`, 45 of 50 overlays, thread panel, every unclassified route | — | — | — |

The one non-trivial curve is duplicated by hand in CSS and JS and has no token.
`--duration-fast/base` and `--easing-standard` exist but cover a minority of
declarations. The reduced-motion rule compresses durations to 0.01 ms instead
of skipping steps; only the phone stack treats it as "skip".

### 2.2 Three history models and two duplicated smart-Backs

- `PhoneNavigationProvider`'s ledger (phone only), `useHistoryNav`'s
  push-position counter (desktop top bar), and `section-route-memory.ts` (the
  rail remembers each section's last path) track the same router separately.
- `AgentDesignerPage.handleBack` and `useWorkflowGraphIO.handleBack` implement
  the identical `history.state.idx > 0 ? navigate(-1) : replace(returnTo ??
  fallback)` logic verbatim.
- `AppDetailPage`, `ThreadReplyPanel`, and `ChannelConversationComposePage`
  each render their own Back button that bypasses the shared doorway.

### 2.3 The route classifier has holes

`phone-navigation.ts` classifies Channels, Projects, Knowledge, Dashboards, Apps
and `/settings` with real depths. Everything else in `ADMIN_ROUTE_PREFIXES`
collapses to one `admin:detail` key at depth 1, so **no push inside the Agents
family or between settings pages animates**, `/settings/statuses/:id` cannot
return to `/settings/statuses`, `/ops/usage` cannot return to `/ops`, and a
sub-agent drill-in is invisible. `/alerts`, `/feedback`, `/threads`, `/work`,
`/chats` are classified as nothing at all: they render **outside** the phone
stack, lose the retained lower screens, and their Back says "Back to
Channels" whatever section the person came from.

### 2.4 Back ownership is split five ways

`PhoneNavigationButton` resolves local Back > route Back > menu, and the edge
swipe, Android hardware Back and the native bridge all feed the same
`performBack`. That part is right. But only three surfaces register a local
Back (`ColumnBrowserColumn`, `AgentDetailPage`, `KnowledgeWorkspace`); none of
the 50 overlays do, so hardware Back leaves the page under an open dialog; the
thread panel and compose page close themselves; `AgentDetailPage` registers at
priority 20, above the knowledge stages (11–14) nested in its Documents tab, so
Back leaves the agent instead of unwinding the document; and the attachments
drawer, wikilink navigation and dashboard side panels have no Back at all.

### 2.5 Two shapes of "tab"

Fifteen in-page switches use three state models: component state (channel
tabs, agent detail, executors, appearance, knowledge view mode), URL search
param with `replace` (app detail, apps filter, search mode), and the project
sections as **seven real history pushes** onto seven route entries while the
phone matrix folds them into one screen. Browser Back therefore walks through
project sections but not through channel tabs.

### 2.6 Effect-driven redirects race the slide

Six effects navigate as soon as data arrives (`ChannelsPage` auto-selects the
first channel, `StatusesPage` the first status, `IncomingCallProvider` strips
call params, the message-highlight and DeepWater-preset consumers clear state,
`LoginPage`/`BootstrapPage` redirect on session). None is aware of an
in-flight transition. One real bug: `navigate('/workflows', { state })` from
`WorkflowRunCard` and `ChannelAutomationsPanel` loses its state at the
`/workflows → /agents/workflows` `<Navigate>` redirect, so "Open" never
pre-selects the run.

### 2.7 Form-factor decisions are spread out

`usePhoneLayout` / `useTabletShell` / `useMobileLayout` are the shell's
classification, but `AttachmentsDrawer` keys on Tailwind `sm:`, the thread
panel on 900/1280 px, `ColumnBrowserViewport` on `lg`, Kanban on measured
width, the project Docs rail on nothing (208 px at every width), and the task
dialog is 1100 px wide on a phone. The 2026-08-13 responsive-coherence plan
already specifies the answer — a semantic shell layout `navigation: 'single' |
'split'` on `ShellEnvironment` — and its Phase 5 (per-surface conversion) is
exactly the work this plan continues.

### 2.8 The native shell is not the problem

The Expo shell never animates route changes; the WebView is persistent across
navigation; it draws only the tab bar, header, toolbar and creation menu.
Phones already have the native back/forward swipe off so the web gesture is
the single owner. The one collision to plan for: iPad and large-phone
landscape keep the native swipe on, and it must go off wherever the detail
column starts pushing.

## 3. Page types

Every stage in the census is one of six types. The type is declared once, in
the surface registry (§4.1), and everything else is derived.

| type | what it is | container by layout | motion | Back |
| --- | --- | --- | --- | --- |
| **Root** | a section's home: Channels, Projects, Knowledge, Admin, Search | single: the whole content region; split: the pinned list column | none (tab taps are instant, as native tab bars are) | none; shows the menu doorway |
| **Detail** | a screen with one parent: channel, project, space, app, agent, settings page, dashboard list | single: pushed over the Root; split: the detail column | push / pop | to its parent |
| **Nested detail** | a push from a Detail: channel info → members → add; app → connect flow; folder → document → history → editor; workflow → installation → run; `/ops` → `/ops/usage`; `/settings/statuses` → `:id` | single: pushed; split: pushed **inside the detail column** (list stays) | push / pop | to the previous stage |
| **Tab host** | a Detail whose sections swap in place: channel Messages/Files/Automations/Agents; project Overview…Settings; agent detail; app detail; executor detail; appearance; knowledge view mode; DeepWater panel | same as its Detail | none (pill slide only) | not a stage; Back leaves the host |
| **Flow** | a full-screen form or wizard: compose message, document stream, task, launchers, trigger editor, avatar crop, session debug, connect | single: a pushed screen; split: a centred panel | push / pop when a screen; open / close when a panel | closes the flow |
| **Overlay** | dialog, confirm, drawer, popover, sheet, viewer, search | same at every layout | open / close | closes the overlay, and nothing else |

Rules that fall out of the table:

- A **sibling swap** (channel A → B, space A → B, status A → B) is not a type.
  It is a Detail whose identity key is unchanged, so it swaps content with no
  motion. That is already how the matrix's `identityOf` / `keyScope` works.
- A Tab host's tab is **never** a history entry. All fifteen strips move to
  one model: the tab lives in a URL search param written with `replace`, so it
  is linkable and refresh-safe but browser Back leaves the host. The project
  sections keep their seven routes for compatibility but the header switches
  them with `replace`, and the matrix keeps folding them into one key.
- A Flow is a screen on `single` and a panel on `split`. That is the one
  place a component branches on layout, and it branches on
  `ShellEnvironment.navigation`, never on a breakpoint.
- An Overlay registers with the Back registry while open. Hardware Back,
  Escape, the scrim and the edge swipe all close the overlay first.
- Redirect targets (`/`, `/work`, `/chats`, `/workflows`, `/integrations`,
  `/settings` on split) are not stages. They forward `state` and never cause
  a transition of their own.

## 4. The framework

Rule zero applies to motion the way it applies to controls: one
implementation of a push, parameterised by where it is mounted, and no second
one. The pieces below replace the five vocabularies, the three history models,
and the split Back ownership. Names are proposals.

### 4.1 Surface registry — `admin/src/navigation/surfaces.ts`

One declarative table replaces `phone-navigation.ts`'s matrix,
`ADMIN_ROUTE_PREFIXES`, the `section-route-memory` set and the per-page
`backTo` knowledge. Each row: route pattern, `type`, `section`, `depth`,
`identityOf`, `parentOf`, and `flowPresentation` for Flows. The classifier
functions keep their signatures (`getNavigationScreen`, `getNavigationDirection`,
`getBackTarget`) so the existing pure tests extend rather than rewrite. It is
**total**: every authenticated route resolves, the `admin:detail` catch-all is
deleted, and a lint test asserts that every path in `router.tsx` has a row.

Concrete depth assignments the census requires: `/threads`, `/unread-messages`
depth 1 under Channels; `/alerts` and `/feedback` depth 1 under Admin (they are
reachable from the bell and the account menu, so they need a home; Admin is
the section whose sidebar they sit beside); `/agents` 1, `/agents/:id` 2,
`/agents/designer[/:id]` 2 as a Flow, `/agents/workflow-designer` 2 as a Flow,
`/agents/{workflows,triggers,tools,executors}` 1 with their column stages as
nested details; `/settings/*` 1, `/settings/statuses/:id` 2; `/ops` 1,
`/ops/usage` 2; `/dashboards` stays 1 under Knowledge.

State-driven stages (knowledge folder/document/history/editor, column-browser
columns, workflow installation/run, integrations product, executors selection,
dashboard side panels, thread panel below `split`) register as **nested
details with a synthetic key** through `useNestedStage()` (§4.4), so the stack
treats them exactly like route pushes. Executors' three search-param panels
and the hash token become one nested stage each instead of `replaceState`.

### 4.2 Navigation controller — `admin/src/navigation/controller.ts`

One provider around the authenticated shell owning:

- **One history ledger** (the phone ledger, promoted). `useHistoryNav`'s
  counter and `section-route-memory` become reads on it. The rail's "return to
  where I was in this section" and the top bar's Back/Forward enablement come
  from the same entries as the phone's pop-vs-replace decision.
- **One `navigate` wrapper** with typed intents: `push(to)`, `replace(to)`,
  `back()`, `backTo(target)`, `redirect(to)`, `openFlow(...)`. `back()` is the
  shared smart Back (pop when the previous entry is the parent, else replace
  with the deterministic parent), which deletes the two designer copies.
  `redirect()` is what the six effect-driven redirects call: it always
  replaces, forwards `state`, and is **deferred until the stack has settled**,
  so a data-arrival redirect can no longer start a second slide under a
  running one. `<Navigate>` elements in `router.tsx` pass `state` through.
- **One Back registry** (the existing `local-back-registry`, promoted).
  Overlays and Flows register on open with a priority above every stage;
  nested stages register by depth. `resolveBack()` is the single function the
  header button, Escape, hardware Back, the native bridge and the edge swipe
  all call. The knowledge-under-agent inversion disappears because priority
  is derived from stack depth, not hand-assigned per component.
- **Native bridge** unchanged in protocol: `nessie:back-state` reports
  `resolveBack() !== null`; `__nessieSelectTab` and `__nessieNativeBack` stay.

### 4.3 Layout — `ShellEnvironment.navigation`

`AdminShellLayout` reads `navigation: 'single' | 'split'` from
`ShellEnvironment` (the responsive-coherence plan's §D, partly delivered) and
mounts:

- `single` (phones, narrow web, iPad in narrow split view): one
  `NavigationStack` over the whole content region, Roots included, as today.
- `split` (tablet, desktop, large-phone landscape): the pinned list column plus
  one `NavigationStack` in the detail column. Detail → Detail sibling swaps are
  instant; Detail → Nested detail pushes inside the column. Flows open as
  centred panels. The native back/forward swipe is turned off on iPad and
  large-phone landscape (`webview-back-gesture.ts` gate extended), because the
  web stack now owns the edge gesture there too.

No page reads a breakpoint to decide its container. `usePhoneLayout` survives
only as the implementation of `navigation === 'single'`.

### 4.4 `NavigationStack` and `useNestedStage`

`PhoneNavigationViewport` becomes `NavigationStack`: the same retained-layer
model (`phone-navigation-stack.ts` unchanged), mounted per §4.3. Its
containers are `overflow: clip`. Its motion is one function:

```
runStackTransition({ top, bottom, direction, from = 0 | 1, reducedMotion })
```

on the Web Animations API, driving the route push, the route pop and the
gesture settle from exactly the current inline transform. The CSS keyframes go.
`useNestedStage({ key, active, onBack })` is how a state-driven stage joins the
stack: it renders its content into a layer, and the stack animates it like a
route. `ColumnBrowserViewport` on `single` becomes a thin wrapper that mounts
each column as a nested stage; on `split` it keeps its multi-column track but
drives it with the same tokens. Knowledge's fade-slide is deleted; folder,
document, history and editor become nested stages.

### 4.5 Motion spec — `admin/src/navigation/motion.ts` + tokens

One source of numbers, exposed as CSS tokens so CSS and JS cannot drift:

| token | value | used by |
| --- | --- | --- |
| `--nav-duration` | 300 ms | push, pop, gesture settle (scaled by remaining travel) |
| `--nav-easing` | `cubic-bezier(0.22, 1, 0.36, 1)` | the same three, and drawers |
| `--nav-parallax` | 0.28 | the underlay |
| `--nav-shadow` | `-12px 0 32px var(--scrim)` | the top layer's edge |
| `--overlay-duration` | 150 ms | dialog / popover open and close (fade + 4 px rise, no scale) |
| `--drawer-duration` | 250 ms | drawers and sheets |

`prefers-reduced-motion` sets every duration to 0 through the same code path:
the transition still runs, still settles, still commits; it just takes no
time. The blanket 0.01 ms CSS rule is replaced by the tokens reading the media
query. The gesture's commit thresholds are unchanged (the gesture test pins
that).

### 4.6 `Overlay` base and `Flow`

`Dialog.tsx` stays the one centred shell and gains: open/close motion on the
tokens, registration with the Back registry while open, and `presentation:
'panel' | 'screen'` so a Flow can render through it as a panel on `split`.
The eight drawers converge on one `Drawer` primitive (side, width, motion on
the tokens, registry registration, Escape, focus trap). The fourteen fully
bespoke dialogs either adopt `Dialog` or keep their carve-out with a comment
that names why (`CLAUDE.md` already lists the legitimate carve-outs). Six
overlays with no Escape or focus trap get both for free.

### 4.7 Scroll and focus discipline

- `.navigation-stack`, `.navigation-layer`, `main`, and the column-browser
  wrapper are `overflow: clip`; the page scroller is `overflow-x: clip`.
- `TabBar` scrolls its own track (`track.scrollLeft`), never `scrollIntoView`.
- `useStackSettled()` resolves after the entering layer's transition finishes.
  `autoFocus` on a screen becomes `focus({ preventScroll: true })` after
  settle; the composer uses it so the keyboard does not rise mid-slide.
- `useScrollMemory` is wired into every stack layer by key (it exists, is used
  once, and `ColumnBrowserColumn` never receives a key today).
- Horizontal scrollers that legitimately own an edge drag (Kanban pages, the
  Knowledge columns strip on `split`) carry `data-navigation-swipe-ignore`; the
  gesture's existing target gate reads it.

## 5. Stage assignment

Every census stage maps to a type. Families, not individual rows; the full
per-stage tables live in the census outputs and the registry is the durable
form.

| family | Root | Detail | Nested detail | Tab host | Flow | Overlay |
| --- | --- | --- | --- | --- | --- | --- |
| Channels | `/channels` | conversation, `/channels/projects/:id`, `/unread-messages`, `/threads` | info → members → add; reply thread (`single`) | Messages / Files / Automations / Agents | compose (`/channels/new`), document stream, DeepWater + executor launchers, record routine | members popup, channel settings + archive confirm, agent/user info drawers, call dialogs, thought process, attachment viewer, secret capture, emoji pickers, reaction popover, search strip |
| Projects | `/projects` | project | (none by route) | Overview / Board / Backlog / Insights / Docs / Executors / Settings | task create/edit | members dialog, project menus, create/edit/delete project, iteration and column confirms, archive-done menu |
| Dashboards | — | `/dashboards` | `/dashboards/:id`; add-widget panel; versions panel (nested stages on `single`, side panels on `split`) | edit mode (a mode toggle with its own Back that discards the draft) | — | — |
| Knowledge | `/knowledge-base` | space, product view | folder, document / file, history, editor (nested stages); zip peek | Full / Column / Tree, needs-review filter | — | attachments drawer, space settings, create space, file version upload, notes card and composer, wikilink confirm and suggestions, drop overlays |
| Agents | Admin | `/agents`, `/agents/:id` | sub-agent (a Detail whose parent is the agent, so Back returns to it) | Edit / To-dos / Activity / Sub-agents / Tools / Messages / Documents | designer, workflow designer | design-assistant drawer, avatar quick edit + cropper, model combobox, to-do editors, workflow node menus, `AgentDetailDrawer` (dead code, delete) |
| Automation | Admin | workflows, triggers, tools, executors | template → installation → run; failed-runs and drafts columns; trigger detail; tool detail; executor selection, access change, promotion | trigger status filter, tool source filter, executor tabs | trigger editor | import, delete confirms, inspector disclosures |
| Apps | Admin | `/apps` | `/apps/:slug` | Overview / Capabilities / Accounts / Agents; All / Installed | connect (dialog on `split`, screen on `single`) | custom app, secret, remove, disconnect confirms |
| Settings + ops | `/settings` | every settings page, `/audit`, `/approvals`, `/alerts`, `/tokens`, `/policy`, `/ops`, `/feedback`, integrations | status detail, `/ops/usage`, integration product | Colours / Text size | logo and photo croppers, session debug | create secret, emoji picker, billing cancellation dialogs, connection expanders |
| Shell | — | — | — | — | — | nav drawer, tab bar, home header, workspace menu, account menu, create menu, alerts bell, top-bar search, native search overlay, rail tooltips, header menus |
| Outside | login, bootstrap, external-auth completion, not-found, service-worker clicks, checkout hand-offs, SSO launches | | | | | never inside the stack |

## 6. Refactor order

Each step is independently shippable, verified with headless Playwright at
phone, tablet and desktop widths, and leaves the app consistent at its own
level. Commit and push per step.

1. **Kill the bounce.** `overflow: clip` on the four containers, `TabBar`
   track-only scroll, `focus({ preventScroll: true })` on the mount-time
   focus calls. Verify on device and with `repro.mjs`.
2. **One motion spec.** Tokens + `runStackTransition`; the route push and the
   gesture settle share it; delete the keyframes and the blanket reduced-motion
   rule. Rewrite `phone-back-swipe-viewport.test.ts` and the keyframe regex in
   `phone-navigation-transition.test.ts` against the function; add the
   duration-parity test.
3. **Total registry.** Every route classified with real depths; delete
   `admin:detail`; `/alerts`, `/feedback`, `/threads` join their sections; the
   lint test that every router path has a row. Extend
   `phone-navigation-routes.test.ts` and the native `tabs.test.ts` mapping.
   With this alone, every Agents and Settings push animates on a phone.
4. **One controller.** Promote the ledger and the Back registry; add
   `redirect()`, `back()`, `openFlow()`; delete `useHistoryNav`'s counter,
   `section-route-memory`, and the two designer smart-Backs; forward `state`
   through the `<Navigate>` redirects (fixes the workflow-run bug); route the
   six effect redirects through `redirect()`.
5. **Split layout.** `ShellEnvironment.navigation`; `NavigationStack` in the
   detail column; iPad and large-phone-landscape native swipe off; the thread
   panel becomes a nested stage on `single` and a token-driven side panel on
   `split`; project Docs rail and dashboard side panels follow the layout.
6. **Nested stages.** `useNestedStage`; fold `ColumnBrowserViewport` (phone),
   Knowledge folder/document/history/editor, workflows/triggers/tools/
   integrations columns, executors panels and dashboard panels into the stack.
   Delete `animate-kb-view-slide`. Rewrite `phone-back-doorway.test.ts` and
   `knowledge-local-back.test.ts` against the registry.
7. **Tab hosts.** One state model (URL param, `replace`) for all fifteen
   strips; project section switch uses `replace`.
8. **Overlays and Flows.** `Dialog` motion + registry; one `Drawer`; Flows
   present per layout; the fourteen bespoke dialogs adopt or justify.
9. **Docs.** `CLAUDE.md` → "Theming / design system" gains "One navigation
   stack" and "One motion spec"; `AGENTS.md` Rule zero point 4 cites it;
   `docs/plans/2026-08-13-responsive-coherence.md` Phase 5 marked delivered by
   this plan; this file moves to `docs/done/` when built.

## 7. Decisions to confirm before step 3

These change behaviour a person can see, so they are named rather than assumed:

- **Project sections stop being history entries.** Today Back walks
  Board → Docs → Settings; after step 7 Back leaves the project, as it does for
  every other tab host. Assumed yes, for consistency.
- **`/alerts` and `/feedback` live under Admin.** Their Back reads "Back to
  Admin" and the drawer shows the admin nav. Assumed yes.
- **Dialogs get a 150 ms fade.** Today they are instant everywhere. Assumed
  yes, on the same curve, no scale.
- **iPad loses the native back/forward swipe.** The web stack owns the edge
  gesture in the detail column instead. Assumed yes; it already does on phones.
- **`AgentDetailDrawer` is deleted.** No call site references it. Assumed yes.
