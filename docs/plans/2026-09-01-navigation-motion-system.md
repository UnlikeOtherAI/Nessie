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
| **Overlay** | anything painted over the current stage: modal, sheet, popover, card (§3.1) | same at every layout, presentation per kind | open / close per kind | closes the overlay, and nothing else |

### 3.1 The overlay family

Overlays are not one thing. The census found 50 of them plus the toast stack,
the call banner and the incoming-call dialog, using fourteen different
z-index values and five different dismissal contracts. They become four
kinds, each with one primitive, one motion, one stacking layer and one Back
rule:

| kind | examples today | anchoring | motion (tokens §4.5) | dismiss | Back / Escape | layer |
| --- | --- | --- | --- | --- | --- | --- |
| **Modal** | the 32 centred dialogs and confirms, flow panels on `split`, croppers, viewers, session debug | centred over a scrim; `full` on `single` for viewers and flows | fade + 4 px rise, `--overlay-duration` | close, scrim press-and-release, Escape | registers with the Back registry while open; hardware Back and the edge swipe close it | `--layer-modal` |
| **Sheet** | the 8 drawers: nav drawer, attachments, agent/user info, agent quick view, thread panel on 900–1279 px, design assistant | edge-anchored (left, right, bottom); `full` width on `single` | slide from its edge, `--drawer-duration`, `--nav-easing` | close, scrim, Escape, swipe toward its edge | registers with Back; one sheet at a time | `--layer-sheet` |
| **Popover** | account, workspace, create, header menus, alerts bell, emoji and assignee pickers, model combobox, wikilink suggestions, status picker, reaction "who", rail tooltips, header overflow | anchored to a trigger, flipped and clamped to the viewport by one placement helper | fade + 4 px rise, `--popover-duration` | outside press, Escape, trigger toggle | registers with Back **only on `single`** (Android hardware Back closes a menu, never leaves the page); Escape always | `--layer-popover` |
| **Card** | the toast stack (`NotificationsProvider`, one `ToastViewport`), the in-conversation call banner, the incoming-call ring, the rolling document-stream chips | a fixed viewport region: top-right on `split`, above the tab bar on `single`; the call banner is in-flow in its conversation | slide in from its edge and fade, `--card-duration`; auto-dismiss timer unchanged | tap (opens its target through the controller), dismiss button, timer | never owns Back; never traps focus; `role="status"` stays | `--layer-card` |

Rules for the family:

- **One primitive per kind**: `Modal` (the existing `Dialog`, extended),
  `Sheet`, `Popover`, `Card`. The fourteen bespoke dialogs and the six
  overlays with no Escape or focus trap adopt the primitive or keep a
  carve-out comment naming why (`CLAUDE.md` already lists the legitimate ones:
  edge-anchored drawers, the full-screen search overlay, the scroll-locking
  attachment viewer, and the two dialogs that branch their scrim on phone —
  all four become `Sheet`/`Modal` presentations rather than carve-outs).
- **One layer scale** replaces `z-40 … z-[110]`, `9999`, `10000`:
  `--layer-stack` (the navigation layers), `--layer-card`, `--layer-popover`,
  `--layer-sheet`, `--layer-modal`, `--layer-blocking` (leave-confirm over a
  streaming document). A card never covers a modal; a popover opened from a
  modal renders above it because it is portaled into the modal's layer root.
- **Stacking is explicit.** A modal over a modal (app connect → secret) is a
  Flow step, not two modals; the primitive refuses to open a second modal and
  the flow advances in place. A confirm inside a modal (channel settings →
  archive) is the one sanctioned nesting and renders in `--layer-blocking`.
- **Every overlay closes through the same registry the stack uses**, so
  hardware Back, the header button, the edge swipe and Escape agree, and an
  open overlay is closed before any route change is allowed to slide.
- **Cards are the one overlay that is transition-aware in the other
  direction**: a card that arrives during a push waits for the settle before
  sliding in, so two motions never run at once on a phone.
- **Placement is one helper.** The popover flip/clamp logic that exists five
  times (`WorkspaceMenu`, `ReactionPills`, `StatusEmojiPicker`,
  `WikilinkSuggestionMenu`, `ResponsivePageHeader`) becomes `placePopover`,
  and the toast viewport's own `max-width: 639.98px` media query — one more
  breakpoint fork — is replaced by the shell's `navigation` value.

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
`/ops/usage` 2; `/dashboards` stays 1 under Knowledge. A row may declare
`parent: 'origin'` for a Detail reachable from every section (`/alerts`,
`/feedback`): Back pops to the previous in-app entry when the ledger has one,
else replaces with the section root.

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
| `--overlay-duration` | 150 ms | modal open and close (fade + 4 px rise, no scale) |
| `--popover-duration` | 120 ms | popovers, menus, pickers, tooltips |
| `--drawer-duration` | 250 ms | sheets and drawers, on `--nav-easing` |
| `--card-duration` | 200 ms | toast and notification cards, call banner, ring |
| `--layer-*` | stack < card < popover < sheet < modal < blocking | every overlay's z-index; no literal z-index outside these |

`prefers-reduced-motion` sets every duration to 0 through the same code path:
the transition still runs, still settles, still commits; it just takes no
time. The blanket 0.01 ms CSS rule is replaced by the tokens reading the media
query. The gesture's commit thresholds are unchanged (the gesture test pins
that).

### 4.6 The overlay primitives and `Flow`

Four primitives, one per kind in §3.1, all in `components/overlays/`, all
composing the same `useOverlay({ kind, onClose, backOwnership })` hook that
does the shared work once: registry registration, Escape, focus trap and
restore (modal and sheet only), scrim press-and-release, layer assignment,
and the open/close motion on the kind's token with reduced motion at 0 ms.

- **`Modal`** is `Dialog.tsx`, extended with motion, registry, and
  `presentation: 'panel' | 'full'`, so a Flow renders through it as a panel
  on `split` and as a full screen on `single` (compose, document stream,
  task, launchers, trigger editor, connect).
- **`Sheet`** replaces the eight hand-rolled drawers: `side`, `size`, a
  swipe-to-close along its axis on touch, and `full` width on `single`.
- **`Popover`** replaces every menu, picker and tooltip: `anchor`,
  `placement`, the one `placePopover` helper, outside-press and Escape, and
  Back registration only on `single`.
- **`Card`** replaces the toast markup and hosts the call banner and the
  incoming-call ring: a single `CardViewport` per shell decides the region
  from `navigation`, queues cards during a stack transition, and keeps the
  existing auto-dismiss and tap-to-open behaviour, routed through the
  controller so a tapped card pushes like any link.

Six overlays with no Escape or focus trap today get both from the hook.
`useModalA11y` and `useOverlayDismiss` become the internals of `useOverlay`
rather than things a component may compose on its own.

### 4.7 Back — one control, one resolver, one gesture

The Back census found 25 distinct affordances, 24 label strings, three
hand-drawn left chevrons plus a FontAwesome one, and nine entry points that
resolve Back through five different paths. The good part is already there:
the phone doorway, the edge swipe, Android hardware Back and the native
bridge all reach one `performBack`. Everything else bypasses it. The rules:

**One control.** `BackButton` (today's `PhoneBackButton`, promoted) is the
only Back glyph in the admin: the `m15 19-7-7 7-7` chevron, 36 px circle,
the iOS glass variant preserved as its native-shell style branch. It renders
in the leading lane of every header on every layout, not only on phones —
`ColumnBrowserColumn`, `AgentDetailPage`, `AppDetailPage`, `ThreadReplyPanel`,
the top bar and the two designers all drop their own arrows and text buttons
("Apps", "Agents", "Cancel", the inline `BackArrow`). Its accessible name is
always `Back to <parent title>`; the two buttons whose name today is just
"Apps" or "Agents" gain the Back semantic for screen readers. Close-X stays
the glyph for overlays only, and an overlay never renders a chevron.

**One resolver.** `resolveBack()` on the controller (§4.2) is the only
function that decides what Back does, and it is the same function whether
the caller is the header button, the edge swipe, Android hardware Back, the
iPad toolbar, the desktop top bar, Escape, the browser's own Back, or a mouse
side button. Order: the topmost open overlay → the deepest nested stage → the
route's parent (pop when the ledger's previous entry is it, else replace) →
the section root. Today `PhoneNavigationButton` and `performBack` each
re-implement that order and merely agree by convention; the desktop and iPad
Back/Forward keep two separate counters that never consult overlays or nested
stages, so the tablet toolbar pops the route straight through an open
Knowledge editor. All of that collapses into the one resolver reading the one
ledger and the one registry.

**Browser Back is a POP, and a POP is a Back.** A `POP` that lands on the
current stage's parent animates as a pop and closes overlays first, on every
layout; today it animates only where the phone viewport happens to be
mounted. `history.back()` from an overlay closes the overlay and consumes the
entry, so the URL never moves under a dialog.

**Escape is Back for overlays, never for stages.** Escape closes the topmost
overlay through the resolver (it already stops propagation, and that stays);
it never pops a route. Compose on desktop, the thread panel, the agent and
user info drawers, the attachments drawer, the design assistant and the
knowledge stages gain Escape through `useOverlay` / `useNestedStage` rather
than each wiring `window.keydown`.

**Android tablets.** Hardware Back is wired only where the native swipe is
off, and the native swipe is iOS-only, so an Android tablet today has no
in-app Back at all: the key backgrounds the app from any depth. The bridge
installs the handler on every Android form factor, and `nessie:back-state`
reports `resolveBack() !== null`.

**The edge swipe.** On iOS the true interactive pop belongs to
`UINavigationController`, one view controller per screen. The app is one
WebView with one document, so the native gesture is not available without
one WebView per screen — a rewrite of the shell with a JS runtime, auth, SSE
and theme per screen, and the loss of the retained live stack. WKWebView's
own `allowsBackForwardNavigationGestures` does traverse React Router's
`pushState` entries, but it renders a snapshot that WebKit often fails to
produce for same-document navigation (blank or stale frames, and an iOS
17.5.1+ regression that jumps to the first entry). That is why phones already
turn it off. Decision: **the web gesture is the gesture**, on every layout
that pushes, and it is finished to native feel:

- settle duration scales with remaining travel (a flick from 90 % must not
  take as long as a release at 10 %), on `--nav-easing`;
- the revealed screen gets a dimming scrim proportional to reveal, alongside
  the existing 28 % parallax and edge shadow;
- a light haptic at commit-threshold crossing and on sheet snap, through a
  new `nessie:haptic` bridge message to `expo-haptics`;
- the gesture is refused, as today, on editable targets, inside horizontal
  scrollers, and while a transition runs; it is **not** refused while an
  overlay is open — it closes the overlay, because the resolver does;
- the same gesture drives the detail column on `split`, and iPad and
  large-phone landscape turn the native swipe off (§7);
- reduced motion keeps every threshold and sets the settle to 0 ms.

**Cancel and Close stay distinct from Back.** A flow's Cancel discards and
closes; a header never shows Cancel beside a Back that does the same thing
(the designer renders both today). Close-X closes an overlay. Back is the
leading-lane chevron, and there is exactly one per screen.

### 4.8 Scroll and focus discipline

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
| Agents | Admin | `/agents`, `/agents/:id` | sub-agent (a Detail whose parent is the agent, so Back returns to it) | Edit / To-dos / Activity / Sub-agents / Tools / Messages / Documents | designer, workflow designer | design-assistant drawer, agent quick-view drawer (`AgentDetailDrawer`, mounted from the shell), avatar quick edit + cropper, model combobox, to-do editors, workflow node menus |
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
   **One Back** in the same step: `resolveBack()` behind every entry point
   (header, swipe, hardware Back, iPad toolbar, top bar, Escape, POP);
   `BackButton` replaces the four chevrons and the "Apps" / "Agents" /
   "Cancel" text buttons; Android tablets get the hardware handler; the
   `phone-back-doorway.test.ts` source pins move to the registry. The gesture
   finish (velocity-scaled settle, dimming scrim, `nessie:haptic`) lands
   here too, since it is the same resolver's commit.
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
8. **Overlays and Flows.** The layer scale first (a pure token swap, no
   behaviour change); then `useOverlay` + `Modal`; then `Sheet` (eight
   drawers), `Popover` (menus, pickers, tooltips, one placement helper),
   `Card` (toasts, call banner, incoming-call ring); Flows present per
   layout; the fourteen bespoke dialogs adopt or justify. Rewrite
   `dialog-shell.test.ts` against `useOverlay`; add one test per kind that
   Back closes it before any route change.
9. **Docs.** `CLAUDE.md` → "Theming / design system" gains "One navigation
   stack" and "One motion spec"; `AGENTS.md` Rule zero point 4 cites it;
   `docs/plans/2026-08-13-responsive-coherence.md` Phase 5 marked delivered by
   this plan; this file moves to `docs/done/` when built.

## 7. Decisions (made 2026-09-01, on usability, safety and stability)

These change behaviour a person can see, so they are recorded with the reason:

- **Project sections stop being history entries.** Back leaves the project,
  as it does for every other tab host; the URL still names the section, so
  links and refresh keep working. One rule for all fifteen strips beats a
  special case nobody can predict, and it removes the only place where Back
  could loop through seven entries before leaving a screen.
- **`/alerts` and `/feedback` are Details whose parent is their origin.** They
  are reached from the bell, the account menu and push notifications, from
  any section. Their registry row declares `parent: 'origin'`: Back pops to
  the previous in-app entry when one exists, and falls back to the Admin root
  on a cold deep link. Landing someone on Admin after they tapped a mention
  from Channels would be the surprise; the ledger already knows where they
  were. Their drawer shows the Admin nav, which is where both are listed.
- **Dialogs get a 150 ms fade and 4 px rise, no scale.** Reduced motion makes
  it 0 ms through the same path. Dismissal (Escape, scrim, close) is never
  gated on the animation, so a person can always close a dialog instantly.
- **iPad and large-phone landscape turn the native back/forward swipe off.**
  The native gesture is a WebView-wide switch and cannot be scoped to the
  list column, and two owners of one edge gesture is the exact failure phones
  already fixed. The web stack owns the edge swipe in the detail column; the
  iPad toolbar's Back/Forward buttons keep cross-section history reachable.
- **`AgentDetailDrawer` stays.** The census row calling it dead was wrong: it
  is mounted from `AdminShellLayout.tsx:348` and opened by `selectAgent` from
  `ChannelMessageRow`. It is the agent quick view over a conversation; it
  converges on the shared `Drawer` primitive, registers with Back, and keeps
  reusing `AgentDetailTabs` so the drawer and `/agents/:id` cannot drift.
- **Tab state lives in a URL search param written with `replace`.** Linkable
  and refresh-safe, never a history entry, one model everywhere. Component-
  only tab state is migrated; nothing new may introduce it.
- **Safety floor for every step.** No step removes a Back path before its
  replacement is in place; `overflow: clip` ships first and alone so the
  bounce fix cannot be entangled with a refactor regression; each step lands
  with its rewritten tests and a Playwright pass at phone, tablet and desktop
  widths before the next begins.
