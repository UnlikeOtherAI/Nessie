# Navigation — how it is done

This is the standing rulebook for anything that moves a person between
screens, opens an overlay, or handles Back, in the admin (`admin/`), the
native shells (`mobile/`, `desktop/`) and the tests that pin them. It is
being built in the order laid out in
[`plans/2026-09-01-navigation-motion-system.md`](plans/2026-09-01-navigation-motion-system.md);
each section below says what is **built** and what is still **planned**, so
this file is never ahead of the code. When the plan is done it moves to
`docs/done/` and this file stays.

**The rule:** there is one navigation framework. Adding a second way to push
a screen, slide a layer, open an overlay, decide Back, or classify a route is
the defect Rule zero names. If what you need is not here, extend the
framework; do not go around it.

## 1. Page types

Every screen is exactly one of six types, and the type decides its container,
its motion and its Back rule. The type is **declared**, not inferred: every
route names its own in the surface registry (§4). **Built** (step 3) for the
five route types; Overlay, and the state-driven stages that register as Nested
details, arrive with steps 6 and 8.

| type | what it is | motion | Back |
| --- | --- | --- | --- |
| Root | a section's home (Channels, Projects, Knowledge, Admin, Search) | none | none; shows the menu |
| Detail | a screen with one parent | push / pop | to its parent |
| Nested detail | a push from a Detail (info → members → add; folder → document) | push / pop | to the previous stage |
| Tab host | a Detail whose sections swap in place | none (pill only) | leaves the host |
| Flow | a full-screen form or wizard; a screen on phones, a panel on split layouts | push / pop or open / close | closes the flow |
| Overlay | modal, sheet, popover, card | open / close | closes the overlay only |

A sibling swap (channel A → B) is a Detail whose identity key is unchanged and
never animates. A tab is never a history entry. A route that only forwards to
another one is not a screen at all: it carries `type: 'redirect'`, so it is
listed (the totality gate needs it, and the tab bar stays lit for the frame it
exists) but never classifies, never animates and never owns a Back.

### Tab hosts — **built** (step 7)

Fifteen in-page strips used three state models: component state, a URL search
param, and the project's seven route entries. They are now one model —
`admin/src/navigation/useTabParam.ts`:

```ts
const [tab, selectTab] = useTabParam('tab', CHANNEL_TABS, 'messages')
```

It reads the param, validates it against the strip's own values (an unknown or
absent value reads as the fallback, so an old bookmark degrades to the tab the
host opens on rather than a blank panel), and writes with
`setSearchParams(…, { replace: true })`. So a tab is **linkable and
refresh-safe but never a history entry**, and Back leaves the host. Every
other search param and the entry's `state` are carried over, so two strips on
one page cannot overwrite each other. Selecting the fallback deletes the param
rather than spelling out the default. No page keeps a tab in `useState` any
more, and nothing new may.

`fallback` is also the seam for a remembered preference: a host that stores its
last choice passes the stored value as the fallback and writes its store beside
`selectTab`, so the URL wins when it names a tab and the preference decides when
it does not. Three hosts do that — the knowledge view-mode cookie, the apps
filter (`localStorage`) and the agents scope (the session ledger). Each reads
its store **once per mount**: a fallback that moved after every write would
chase the param-deletion rule.

| host | param | values |
| --- | --- | --- |
| a conversation (`useChannelTab`) | `tab` | `messages` · `files` · `automations` · `agents` |
| an app (`AppDetailPage`) | `tab` | `overview` · `capabilities` · `accounts` · `agents` (as the app offers) |
| an executor (`ExecutorDetailPanels`) | `tab` | `overview` · `access` · `operations` · `sessions` · `attention` |
| Appearance (`/settings/appearance`) | `tab` | `colours` · `type` |
| an agent (`AgentDetailTabs`) | `agentTab` | `edit` · `to-dos` · `activity` · `sub-agents` · `tools` · `messages` · `documents` |
| the apps catalogue (`AppsPage`) | `filter` | `all` · `installed` (default: this device's last view) |
| the agents list (`AgentsList`) | `scope` | `personal` · `team` · `global` (default: the session ledger) |
| the tool registry (`ToolsPage`) | `source` | `all` · `builtin` · `custom` · `mcp-remote` · `interactive-session` |
| the trigger list (`useTriggersPageState`) | `status` | `all` · `active` · `paused` · `error` |
| full-page search (`SearchPage`) | `mode` | `text` · `semantic` (default: this device's last mode) |
| a knowledge space (`KnowledgeWorkspace`) | `view` | `full` · `column` · `tree` (default: the `knowledgeViewMode` cookie) |
| Deep Water (`DeepWaterResearchPanel`) | `research` | `run` · `runs` · `settings` |

A named param is used wherever `tab` would collide: `agentTab` because the
agent strip also renders inside the quick-view sheet over a conversation that
owns `?tab=`, and `research` because that panel sits inside a product detail on
the Integrations page. A strip that narrows a list (`role="radiogroup"`) uses
the same hook — `filter`, `scope`, `source`, `status` are filters, not panel
switches.

**Projects keep seven routes.** `/projects/:id` and its `/board`, `/backlog`,
`/insights`, `/docs`, `/executors`, `/settings` siblings stay real routes so
each is linkable, but the header's section menu navigates with `replace: true`,
so Back leaves the project instead of walking the sections a reader passed
through. The registry folds all seven into one `tabHost` identity and they
render the same element, so React reconciles one `ProjectView` across them: the
switch swaps the section without remounting the page or animating a layer.

**Three deliberate non-hosts**, each recorded where it stands: the scope choice
in `AppConnectDialog` and the key scope in `AppSecretDialog` are fields of a
form inside a modal — answered once and submitted, so a URL param would outlive
the dialog and collide with the tab of the page it was opened over; and the
top-bar search overlay's mode stays a device preference, because that overlay
floats over whatever route the reader is on.

Pinned by `admin/test/tab-param.test.ts`: the hook's three promises under a
`MemoryRouter`, the project switch's `replace` and single mount, the host/param
table above, and a source gate over `git ls-files` that fails when any file
rendering a `<TabBar` keeps its value in `useState` (allowlist: the two dialog
form fields, and it only ever shrinks).

## 2. Stack containers never scroll — **built** (step 1)

The navigation stack's containers are `overflow: clip`, never `hidden`:
`.phone-navigation-viewport`, `.phone-navigation-screen`, the shell's `main`,
and the column-browser wrapper. A hidden-overflow box is still a scroll
container, so any `scrollIntoView()` or `focus()` inside a screen that is
parked off to the right during a push scrolls it sideways; the transform
animation then runs on the compositor with that stale offset and the screen
lands short of its resting place until the next layout clamps it. That was
the bounce. The page scroller itself stays `overflow-x: hidden; overflow-y:
auto` (a `clip` axis computes to `hidden` beside a scrolling axis).

Consequences for page code:

- `TabBar` scrolls its own track (`track.scrollLeft`) and never calls
  `scrollIntoView`. Nothing else in a screen may call `scrollIntoView` from a
  layout effect either.
- A focus call that runs on mount uses `focus({ preventScroll: true })`.
- Pinned by `admin/test/phone-navigation-transition.test.ts` ("stack
  containers clip rather than hide"). Reproduction of the defect:
  `plans/2026-09-01-navigation-motion-system/repro.mjs`.

## 3. Motion — **built** (step 2)

One spec, `admin/src/navigation/motion.ts`:

- `NAV_MOTION`: 300 ms, `cubic-bezier(0.22, 1, 0.36, 1)` (control points
  inside [0, 1], so it cannot overshoot), parallax 0.28, a 120 ms floor for a
  settle. `OVERLAY_MOTION`: modal 150, popover 120, drawer 250, card 200 ms
  (declared; the overlay primitives adopt them in step 8).
- `runStackTransition({ top, bottom, direction, progress, reducedMotion })`
  is the **only** thing that moves a navigation layer. It animates the two
  layers on the Web Animations API from exactly their current transform to
  the end poses, scaled to the travel that remains, and resolves `finished`
  when the top layer arrives. A route push, a route pop and a released edge
  swipe all call it; nothing else may animate a `.phone-navigation-screen`.
- Reduced motion is 0 ms through the same path: the transition still runs,
  settles and commits.
- `styles.css` declares only the **static poses** (`--forward-ready`,
  `--underlay`, `--current`, …) and mirrors the numbers as `--nav-duration`,
  `--nav-easing`, `--nav-parallax`, `--nav-shadow`. There are no
  `@keyframes phone-navigation-*`; `admin/test/navigation-motion.test.ts`
  pins the tokens equal to `NAV_MOTION` and
  `admin/test/phone-navigation-transition.test.ts` pins the keyframe count at
  zero.
- Tests: the JSDOM harness (`admin/test/support/phone-navigation-viewport-harness.ts`)
  supplies a fake `Element.prototype.animate` timeline on real timers, so a
  transition is driven to completion by the animation's finish, not by the
  viewport's fallback timer.
- The blanket `prefers-reduced-motion` CSS rule stays as the baseline for
  non-navigation CSS motion; navigation reads the query in JS.

## 4. Registry, controller and Back — **built** (steps 3–4)

### 4.1 The surface registry — `admin/src/navigation/surfaces.ts`

One declarative table classifies every route; the vocabulary a row is written
in — the page types of §1 and the row shape — is `navigation/page-types.ts`
beside it. A row is: `pattern`, `type`
(§1, plus `redirect`), `section`, `depth`, `root`, `identityOf` / `keyScope`
(which screens are the *same* screen, so a sibling swap swaps content in
place), `parentOf(match)` → `{ label, pathname }` (what Back returns to, and
what it announces), `intent` (the params the route reads beyond its path —
§8), and optionally `parent: 'origin'`, `contextualList` or
`flowPresentation`. Everything else derives from it: the lookups live in
`navigation/surface-lookup.ts` (`surfaceScreen` / `surfaceSeedChain` /
`surfaceParent` / `surfaceRootPath`, over `matchSurface`), and
`phone-navigation.ts` is a thin adapter over them, so the stack, the ledger,
`resolveBack()`, the Back doorway and the native bridge all read one table.

- **It is total.** There is no catch-all row and no fallback classification.
  `admin/test/navigation-surfaces-total.test.ts` and
  `scripts/lint-navigation-surfaces.mjs` (in the root `lint` chain) both read
  `router.tsx`, join nested child paths to their parents, and assert every
  path resolves to a row — or is one of the four the registry itself lists as
  outside the stack (`OUTSIDE_STACK_PATHS`: login, the external-auth
  completion, bootstrap, not-found). **Adding a route means adding its row**;
  the lint is what makes that unmissable. The old `admin:detail` catch-all is
  deleted, and because classification can no longer fail, the shell mounts the
  phone viewport unconditionally.
- **Depths** (plan §4.1): `/threads` and `/unread-messages` are Channels
  details at depth 1, `/channels/new` a Channels Flow at depth 1; `/agents` 1,
  `/agents/:id` 2, both designers Flows at 2 returning to the list they edit,
  the four automation browsers 1; every settings page 1 with
  `/settings/statuses/:id` at 2; `/ops` 1 and `/ops/usage` 2; `/apps` 1 and
  `/apps/:slug` 2; `/audit`, `/approvals`, `/tokens`, `/policy` 1. A project's
  seven section routes are one `tabHost` identity, so switching sections never
  animates.
- **`parent: 'origin'`** (`/alerts`, `/feedback`): reached from the bell, the
  account menu and push notifications, from any section, so Back pops to the
  reader's real predecessor when the ledger has one and falls back to the
  Admin root only on a cold deep link.
- A page that auto-selects its first row must not do so on a phone once its
  detail is a real pushed screen: the redirect would slide a detail in on
  arrival and re-slide it on every Back. `ChannelsPage` and `StatusesPage`
  both gate that on `usePhoneLayout()`.

### 4.2 The controller

The controller is `PhoneNavigationProvider` (one instance around the
authenticated shell; the name follows in a later rename). It owns:

- **One ledger** (`phone-navigation-ledger.ts`): every PUSH / REPLACE / POP the
  router commits. `navigation/history.ts` derives `canGoBack`, `canGoForward`
  and the last path per section from it. The desktop top bar, the iPad
  toolbar and the rail read those; none keeps a counter of its own.
- **One Back decision**: `navigation/back.ts` `resolveBack()` — the topmost
  registered owner (the local-back registry: an open overlay, the deepest
  nested stage), else the route's parent (pop when the ledger's previous
  entry is it, else replace), else nothing at a root. `performBack()`,
  `PhoneNavigationButton`, the edge swipe, `nessie:back-state` and Android
  hardware Back all go through it. An owner may register `swipeable: false`.
  A `parent: 'origin'` screen (`/alerts`, `/feedback`, `/ops/usage`) pops to
  the reader's real predecessor and its control says only "Back"; on a cold
  link it replaces to the declared fallback and names it.
- **History controls are not Back.** The top bar and the iPad toolbar walk
  the ledger across sections, which Back never does; they consult the
  registry first so they never pop a route under an open owner.
- **`back({ returnTo, returnToState, fallback })`** is the shared smart Back:
  an explicit return address wins, else a real previous entry pops, else the
  fallback replaces. The two designers use it; nobody reads
  `history.state.idx` any more.
- **`redirect(to, { state })`** (`navigation/redirect.ts`, also
  `useRedirect()` for components outside the provider) is what every
  effect-driven navigation calls: it replaces, forwards state, waits for the
  stack to settle (`transition-state.ts`), and is dropped if the location
  moved on. The first-channel and first-status auto-selects, the session
  redirects, the call, message-highlight and DeepWater intent consumers and
  the landscape rotation redirect all use it.
- **`useStackSettled()`** tells a screen when its slide has landed.

- **`RedirectRoute`** (`navigation/RedirectRoute.tsx`) is the only
  route-level redirect: it replaces and forwards `location.state`, so a
  notification deep link or a return address that lands on a retired path
  (`/work`, `/chats`, `/settings/tools`, …) arrives intact. `router.tsx`
  never renders a bare `<Navigate>`
  (`admin/test/navigation-redirect-route.test.ts`).
- **The revealed layer is dimmed.** Every screen carries one
  `[data-phone-navigation-dim]` child, a `--scrim`-coloured overlay that is
  fully present while another screen rests over it and gone once that screen
  is away. `stackPoses().dim` gives its opacity, `runStackTransition` animates
  it on the bottom layer beside the transform, and the edge swipe drives it
  inline with the finger — the same three callers, the same numbers, so a
  push, a pop and a released swipe dim identically.

- **A committed swipe gives one `light` haptic** (`lib/haptics.ts`, §10) at
  the moment the settle lands and the route is about to change. A cancelled
  swipe and a tapped Back give none.

The single Back glyph in every header on every layout is `ScreenHeader`'s
leading lane (§9), which renders `PhoneNavigationButton` — the one resolver's
answer — wherever a Back paints.

## 5. Layout — **built** (step 5)

`navigation/layout.ts` `deriveNavigationLayout()` is the one composition of
shell probes × viewport bands into `'single' | 'split'`, read through
`useNavigationLayout()` (`lib/mobile-shell.ts`):

- `single`: phones, narrow web, an iPad in a narrow Split View — one stack
  over the whole content region, Roots included.
- `split`: tablet, desktop, large-phone landscape — the pinned list column
  beside detail stacks.

The native shell decides by its named form factor, never by width alone, so
a phone cannot become multi-column by rotating. The shell frame carries
`data-navigation` with the value. `usePhoneLayout()` survives only as
`navigation === 'single'`; no page reads a breakpoint to decide its
container. Pinned by `admin/test/navigation-layout.test.ts`.

On `split` the shell's detail column (`main`) mounts the same stack
(`PhoneNavigationViewport layout="split"`), and the registry reads
differently there (`surfaceScreen(pathname, layout)`):

- The pinned list column *is* the section's root, so a root and its details
  share the stack floor (depth 1): root → detail swaps in place with nothing
  retained beneath; detail → nested (`/agents` → `/agents/:id`, `/apps` →
  `/apps/:slug`, `/dashboards` → `/dashboards/:id`, a designer) pushes inside
  the column with the detail retained beneath, exactly as on a phone.
- A nested row whose parent page renders it itself on split declares
  `splitInline: true` (the conversation's info chain and reply thread, a
  status's detail) and classifies as its parent's screen there, so it neither
  pushes nor animates. Declared per row, never inferred.
- No edge swipe arms on split: the column has no edge of its own, and on
  iPad the native swipe stays on until step 9.

Verified in the browser at 1280×800 and 768×1024: `/agents` →
`/agents/designer` slides inside the detail column over the dimmed, retained
list and pops back; a conversation → its info and a status list → a status
stay one layer. The page-owned detail columns (Knowledge, the column
browsers, Dashboards) join the stack as nested stages in step 6; the thread
panel becomes a nested stage on `single` and a `Sheet` on `split` in step 8.

## 6. Nested stages — **built** (step 6)

A nested stage is a state-driven screen a page pushes over its own route: a
column browser's next column, a Knowledge folder → document → history →
editor, a dashboard's add-widget panel. It is **one component**,
`navigation/NestedStage.tsx`:

```tsx
<NestedStage id="document" label="Back to folder" active={open} onBack={close} priority={12}>
  …
</NestedStage>
```

- **On a single-column layout it is a layer in the stack**, keyed
  `stage:<id>` one depth above whatever it was pushed over
  (`phone-navigation-stack.ts` `pushPhoneNavigationStage` /
  `popPhoneNavigationStage`). It slides in with the same `runStackTransition`
  as a route, is retained inert under whatever is pushed over it (a route
  pushed over an open stage returns to that stage on Back, not to the list
  beneath), unwinds with Back through the one resolver (it registers with
  the local-back registry as `stage:<id>`), and the edge swipe drives it
  when it is the top layer and `swipeable` (the default). A same-route
  re-render refreshes the route beneath it (`refreshPhoneNavigationRoute`)
  and never touches the stages.
- **The page keeps rendering it.** The content goes through a portal into
  the layer's container, so context, state and providers never leave the
  page; only the DOM moves. Keep the stage mounted and toggle `active` — an
  unmount leaves without motion.
- **Where no stack hosts stages** — a split layout's detail column, a test
  without a viewport — the stage renders inline where it stands and the page
  composes it (the column browser's multi-column track, Knowledge's
  columns). Nothing reads a breakpoint to decide this; the host's presence
  does.
- **Ownership is per instance.** A push over an open stage mounts the page
  again for the new route, so two instances render the same stage id; only
  the instance that pushed the entry may pop it, or the second one's unmount
  would close the first one's open document.
- Pinned by `admin/test/nested-stage-viewport.test.ts` (push, Back, swipe,
  retention under a route) and `admin/test/phone-navigation-stack.test.ts`.

Adopters, all **built**: `ColumnBrowserViewport` — on
`single` column 0 renders inline (it *is* the page) and every column beyond it
is a `stage:column:<k>` layer at `columnBackPriority(k)`, with a `stageScope`
prefixing the ids where one page could mount two browsers; only a column knows
its own title and unwind action, so it reports `{ label, onBack }` up through
the column context in a layout effect and the viewport owns the single
registration (the stage's, or its own local-back owner for a Back-owning column
0, as Workflows' failed-runs column is) — `ColumnBrowserColumn` no longer calls
`useLocalBack` and `PhoneNavigationButton` no longer reads the column context,
because a retained column is no longer rendered at all; on `split` it keeps its
multi-column track, now moved with `var(--nav-duration)`/`var(--nav-easing)`
rather than a `transition-transform duration-300` utility. `ExecutorsPage`'s `ExecutorCreatePanel` (`executors:create`) and
`DashboardDetailPage`'s `AddWidgetPanel` / `DashboardVersionsPanel`
(`dashboard:add-widget`, `dashboard:versions`) are `NestedStage`s — a phone
full screen, today's fixed-width side panel unchanged on `split`.

**Knowledge is built.** `KnowledgeWorkspace` registers no Back of its own;
its four inner screens are stages — `knowledge:folder` (11, a folder browsed
beyond the space root), `knowledge:document` (12, the open document or file),
`knowledge:history` (13) and `knowledge:editor` (14, `swipeable={false}` for
as long as it is open, because `PageEditor` holds its draft in its own state
and publishes no dirty signal). Each keeps the label and the one-level unwind
the single registration used to carry, and the priorities stay
`LOCAL_BACK_PRIORITY`. `animate-kb-view-slide` and its keyframes are deleted:
the stack owns the motion, and `phone-navigation-transition.test.ts` pins the
name out of `admin/src` entirely. Which stages are open is derived from the
provider's own state, and the composition follows the host rather than a
breakpoint (`useNestedStageHosted`): a stack shows every open stage as its own
layer, with the space's root listing kept in the route layer beneath an open
folder — the screen it was pushed over — while an inline host renders only the
deepest pane, exactly the desktop columns, full-width document, history and
editor of before. Pinned by `knowledge-local-back.test.ts` and the
three-layer unwind case in `nested-stage-viewport.test.ts`.

**`AgentDetailPage` is built.** It registers no local Back: `/agents/:id` is a
real depth-2 route whose parent is Agents, so the shared route Back returns
there. Its old `columnBase` registration outranked every Knowledge stage
inside the agent's Documents tab, so Back left the agent instead of unwinding
the open document. Wider layouts keep the page's own Back button beside the
title.

## 7. Overlays — **built** (step 8)

An overlay is one of four kinds — **Modal**, **Sheet**, **Popover**, **Card**
— plus the one sanctioned nesting, **blocking** (a confirm over an open
modal). Each kind has one layer, one Back precedence and one motion, declared
once in `navigation/overlay.ts` and mirrored as tokens:

| kind | layer token | Back | motion |
| --- | --- | --- | --- |
| Card | `--layer-card` 40 | never owns Back | slide + fade, `OVERLAY_MOTION.cardMs` |
| Popover | `--layer-popover` 50 | owns Back on `single` only | fade + 4 px rise, `popoverMs` |
| Sheet | `--layer-sheet` 60 | owns Back | slide from its edge, `drawerMs` |
| Modal | `--layer-modal` 70 | owns Back | fade + 4 px rise, `modalMs` |
| blocking | `--layer-blocking` 80 | outranks the modal beneath | as modal |

`--layer-stack` (1) is the navigation stack's own layer; nothing else in the
admin declares a z-index (the lint gate lands in step 15 once the fifty
overlays have adopted the scale). No scale, ever: a dialog rises 4 px.

**`useOverlay({ id, kind, label, open, onClose, … })`**
(`components/overlays/useOverlay.ts`) is the shared work every overlay does
once: it registers `overlay:<id>` with the Back registry while open (so
hardware Back, the header Back, the edge swipe and Escape agree, and an open
overlay closes before any route change slides), composes the focus trap and
restore (modal, sheet, blocking) or Escape alone (popover), the drag-safe
scrim dismiss, the layer, and the open/close motion on the kind's token with
reduced motion at 0 ms through the same path. Dismissal is never gated on
the motion: state closes at once and the leaving element plays out inert
(`mounted` stays true while `closing`). `useModalA11y` and
`useOverlayDismiss` are its internals, and `admin/test/centred-modal-a11y.test.ts`
pins that nothing outside `useOverlay.ts` imports either one directly any
more. The fourteen bespoke centred dialogs from before this step (step 8)
split two ways, each pinned by `admin/test/dialog-adopters.test.ts`:

- **Onto `Dialog`/`ConfirmDialog`** — `CircleImageCropper` and
  `ExecutorRunLauncherDialog` fit an existing panel size outright;
  `ChannelSettingsDialog`'s hand-rolled archive confirm became the sanctioned
  nested `ConfirmDialog(blocking)`; `DocumentStreamLeaveConfirm` became
  `Dialog blocking` rather than `ConfirmDialog` because its three actions
  (Cancel / Stop and discard / the mode's own "keep writing" verb) don't fit
  `ConfirmDialog`'s two-button cancel/confirm shape.
- **Kept a carve-out on `useOverlay` alone**, each with its reason recorded
  where it stands — `MemberManagementPopup` (a fixed-header, fixed-search,
  independently-scrolling list none of the four geometries express),
  `SessionDebugDialog` (phone-tuned chrome: safe-area insets, a 44px close
  target, a dvh scrolling flex column), `AttachmentViewer` (locks page
  scroll), `AgentAvatarQuickEdit` (an avatar-centred card with no title-bar
  header), `DocumentStreamDialog` (branches its scrim on phone layout),
  `ThoughtProcessDialog` (a fixed-header / scrolling-log / fixed-footer
  split), `UoaBillingCancellationDialog` and
  `DeepWaterResearchLauncherDialog` (each its own `admin-card` panel family,
  the second with a sticky in-scroll header), and `TriggerEditorDialog` (a
  680px panel with a `text-sm` subtitle, neither of which is one of the
  shell's four geometries). `ChannelConversationComposePage` is the
  exception among exceptions: a Flow, not a modal — on `single` it is
  already a full screen in the phone-navigation stack, so it registers
  `useOverlay` only on `split`, where it visually is a centred dialog over
  the channel list.

**`Dialog`** (`components/shared/Dialog.tsx`) is the Modal primitive on this
hook, unchanged in API plus `blocking` for the sanctioned nesting;
`ConfirmDialog` builds on it. **`Sheet`** (`components/overlays/Sheet.tsx`) is
the Sheet primitive on the same hook — `side`, a four-name `size` drawn from
the geometries the drawers actually ship, full width and height on the
`single` layout (the one sanctioned layout branch, never a breakpoint), and a
swipe-to-close that projects the phone back-swipe's own slop, commit ratio and
flick velocity onto the sheet's axis rather than restating them
(`components/overlays/sheet-swipe.ts`). It has replaced the hand-rolled scrim,
literal z-index pair and CSS slide in five drawers: the mobile nav drawer
(`MobileNavDrawer`), the knowledge `AttachmentsDrawer`, the agent quick view
(`AgentDetailDrawer`), and the channel agent and user info drawers — each of
which now gets Escape, a focus trap and restore, `role="dialog"` and a Back
registration it did not have. Two edge cases stay outside it deliberately: the
thread reply panel's 900–1279 px overlay mode, whose three presentations are
one element switched by CSS breakpoints that no `single`/`split` branch can
express, and the design-assistant panel, which is docked in flow rather than
edge-anchored over a scrim.

**`Popover`** (`components/overlays/Popover.tsx`) is the anchored primitive on
the same hook: `anchorRef` (or an `anchorRect`, for a text caret), `placement`,
`label`, `role` (`menu | listbox | dialog | tooltip`), outside press on
`mousedown`/`touchstart`, Escape from the hook, and the popover layer — no CSS
transition of its own. It places itself through **one** `placePopover`
(`components/overlays/placePopover.ts`): given an anchor rect, the panel's
measured size, a preferred placement (`bottom-start | bottom-end | top-start |
top-end | right | left`) and the clipping bounds (`viewportBounds()`, or a
container rect), it flips to the opposite side when the preferred one does not
fit and clamps the panel inside the bounds, returning `{ left, top, placement,
maxHeight }`. It replaced the five private flip/clamp routines
(`WorkspaceMenu`, `UserMenuPopover`, `CreateMenuTrigger`, `ReactionPills`,
`WikilinkSuggestionMenu`, plus `ResponsivePageHeader`'s CSS anchoring), three of
which had no flip at all. Adopted by the account, workspace, create, header and
overflow menus, the alerts bell, the reaction "who reacted" popover, the status
and composer emoji pickers, the assignee picker, the model combobox and the
wikilink suggestion list. Rail tooltips stay as they are: `RailTooltip` is a
hover hint, not a dismissible anchored surface.

**`Card`** (`components/overlays/Card.tsx`) is the ambient kind, and one
**`CardViewport`** per shell (mounted by `ToastProvider`) is the region it lives
in: top-right on `split`, above the tab bar on `single`, decided from
`useNavigationLayout()` — which is what replaced the toast viewport's own
`max-width: 639.98px` media query. A card composes `runOverlayTransition({ kind:
'card' })` directly rather than `useOverlay`, because the three things it must
not do are the point: it never owns Back, never traps focus, and keeps
`role="status"`. A card arriving during a stack transition waits on
`whenStackSettled()` before it appears, so two motions never run at once; the
auto-dismiss timer and tap-to-open are unchanged, and dismissal marks the card
leaving so its motion plays before the owner drops the row. The toast stack is
its first adopter. The in-conversation call banner stays in flow in its
conversation and the incoming-call ring stays a dialog — it asks for a decision
and needs focus, which is exactly what a card refuses to take.

Still planned: the centred-panel rendering of a Flow on `split`. The row
field exists (`flowPresentation`, §1) and every Flow today declares
`screen`, so nothing reads the other value yet.
Pinned by `admin/test/navigation-overlay.test.ts`,
`admin/test/dialog-shell.test.ts`, `admin/test/sheet.test.ts`,
`admin/test/place-popover.test.ts`, `admin/test/popover.test.ts` and
`admin/test/card-viewport.test.ts`.

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
- Pinned by `admin/test/screen-header.test.ts`: the SSR shape (one `h1`, the
  doorway at a screen with a parent and the menu at a root, the optional
  slots), `document.title`, the posted message's six fields, and the source
  gates — `AdminPageHeader` and `MobileSectionHeader` do not exist, nothing
  imports or renders them, and no file under `admin/src/pages/**` paints a
  `<header>` of its own.

## 10. Native shell contract — **built** (step 9 and the bridge pieces)

The `mobile/` ↔ admin bridge facts the plan (§4.7, §4.15, §4.16, §7) calls
out are **built**: Android hardware Back on every form factor, the haptic
bridge, `nessie:screen` and `nessie:attention`, and pull-to-refresh handed to
the web. The haptic call sites are the swipe commit (`light`), a committed
sheet swipe (`light`), a tab change (`selection`, never on a re-tap of the
selected tab) and the incoming-call ring (`warning`); nothing else buzzes.

- **The native back/forward swipe is off on every form factor** (plan §7,
  thrown only once `ScreenHeader` put a Back in every screen's leading
  lane). It is a WebView-wide switch that cannot be scoped to a column, and
  two owners of one edge gesture is the failure phones already fixed. Phones
  keep the admin's edge swipe; iPad and large-phone landscape use the header
  Back and the toolbar's history controls on the one ledger
  (`mobile/src/lib/webview-back-gesture.ts`).

- **`nessie:screen` — what screen the person is on.** Posted by
  `NativePhoneNavigationBridge` beside the unchanged `nessie:route` and
  `nessie:back-state`, so the shell stops re-deriving the tab from a
  hand-copied prefix list and can name the screen in its own chrome:

  ```
  nessie:screen {
    type: 'nessie:screen',
    path: string,
    title: string,
    section: 'channels' | 'projects' | 'knowledge' | 'admin' | 'search',
    screenType: 'root' | 'detail' | 'nested' | 'tabHost' | 'flow',
    depth: number,
    hasBack: boolean,
  }
  ```

  `section`, `screenType` and `depth` are read straight off the surface
  registry (§4.1) — the page type is `screenType`, not `type`, because `type`
  is the bridge's own message discriminant and one key cannot be both.
  `hasBack` is the one Back resolver's answer (§4) and `title` is the header's
  rendered title (§9). It is posted on every settled change of any field and
  on no re-render that changes none. The shell keeps a **last-known section**
  from the latest message, so its tab index is right before the first message
  on a cold start and after the search overlay closes.
- **`nessie:attention { badges }`** carries one unread count per section, keyed
  by the same registry section names (`{ channels, knowledge, projects }`
  today; a section the admin does not count is absent and reads as 0). It
  replaced the old `{ assignedWork, channels, knowledge, total }` shape, whose
  keys were a vocabulary of their own; `total` stays local to the admin, where
  the desktop and browser app badges read it.
- **Android hardware Back installs on every Android form factor.**
  `shouldInstallNativeBackHandler` (`mobile/src/lib/native-phone-navigation.ts`)
  is just `isAndroid` now — it used to also require the iOS-only
  `allowsBackForwardNavigationGestures` WebView prop to read `false`, and that
  prop happens to read `true` past the tablet breakpoint on Android too (where
  it has no effect), so an Android tablet had no in-app Back at all: the key
  backgrounded the app from any depth. Consumption is unchanged
  (`shouldConsumeNativeBack(hasBackDepth)` off the latest back-state — see
  `nessie:screen` below for what now feeds it). Android's predictive back
  gesture is opted in alongside it (`android.predictiveBackGestureEnabled` in
  `mobile/app.json`, per plan §7): React Native 0.81+ (the installed
  `react-native` is 0.83) moved `BackHandler` onto the invoked-callback-compatible
  path so the plain `hardwareBackPress` listener keeps firing with the flag
  on; the system's predictive-back preview only ever shows the launcher,
  never an in-app screen, and the in-app motion stays the web stack's.
- **`nessie:haptic { haptic }` bridge message.** `admin/src/lib/haptics.ts`
  posts it (`haptic(kind)`, `kind` one of `light | medium | heavy | selection
  | success | warning | error`) when running inside the native shell, and
  falls back to the browser's own Vibration API for `warning`/`error` only
  everywhere else. `mobile/src/lib/haptics.ts` guards the message
  (`isHapticMessage`) and maps each kind onto one of expo-haptics'
  `impactAsync` / `selectionAsync` / `notificationAsync` families
  (`triggerHaptic`), wired through `native-shell-message-handler.ts` and
  `App.tsx`. Its callers today are the swipe commit (`light`, §4) and
  `IncomingCallProvider`'s ring (`warning` on native — a one-shot
  notification, not a repeating buzz — the browser path keeps its own
  repeating `navigator.vibrate` pattern via the same helper's fallback); the
  sheet-snap and tab-change triggers §4.15 describes arrive with steps 7–8.
- **The shell stops re-deriving from the pathname what the admin already
  knows (step 9).** It used to match the WebView's reported `nessie:route`
  path against a hand-copied prefix table (`tabIndexForPath`, each
  `TABS[].matches` predicate, `isNativePhoneTabRootRoute`) to guess which tab
  a screen belonged to and whether it was a tab root — all now **deleted**.
  The admin posts, everywhere it posts `nessie:route`, a `nessie:screen`
  message read straight off the surface registry:

  ```
  {
    type: 'nessie:screen',   // the bridge message discriminant
    path: string,
    title: string,
    section: 'channels' | 'projects' | 'knowledge' | 'admin' | 'search',
    screenType: 'root' | 'detail' | 'nested' | 'tabHost' | 'flow',
    depth: number,
    hasBack: boolean,
  }
  ```

  (`screenType` carries the screen's own node type on the wire — a second
  field, distinct from the message's own `type` discriminant, which is always
  the fixed string `'nessie:screen'`.) `mobile/src/lib/native-shell-message.ts`
  `isScreenMessage` guards it; `native-shell-message-handler.ts` keeps a
  **last-known screen** `{ section, title, type, depth, hasBack }` in state
  (`mobile/src/lib/native-shell-layout.ts` `LastKnownScreen`,
  `DEFAULT_LAST_KNOWN_SCREEN` — the Channels tab, root, before the first
  message of a cold start arrives and after the search overlay closes). The
  selected tab index is `tabIndexForSection(lastKnownScreen.section)`
  (`tabs.ts`); the `TABS` table itself stays for titles, paths, and icons.
  Whether the current screen is a tab root — used for the native phone
  header/creation-actions affordance and, via `noteBackState`, hardware Back
  consumption — comes from `screenType === 'root'` / `hasBack`, never from
  matching a path. `nessie:back-state { hasBackDepth }` keeps working during
  the admin's transition to `nessie:screen`; once a `nessie:screen` message
  has arrived it is authoritative and a `nessie:back-state` arriving after it
  no longer overrides Back consumption.
- **`nessie:attention { badges: Record<section, number> }`** carries a badge
  count per tab section (`section` the same five-value union as above,
  replacing the earlier three-field `{ assignedWork, channels, knowledge,
  total }` shape). `isAttentionMessage` guards it;
  `native-shell-presentation.ts` `attentionBadges`/`nativeAttentionTotal`
  read `message.badges`, defaulting every section the admin has not reported
  — including one this build does not know about — to 0, and summing across
  `TABS` for the OS-level app badge rather than trusting a separate `total`
  field. The iPhone (`react-native-bottom-tabs`), iPad
  (`IpadNativeTabBar`/`IpadNativeChrome`), and Android tablet
  (`AndroidTabletTabBar`) tab bars all already had a badge slot; they now read
  `badgeCounts[tab.key]` directly instead of a three-way `channels
  | assignedWork | knowledge` mapping, so every section — including Admin and
  Search — can carry a badge once the admin posts one.

## 11. Verification — the transition suite — **built** (step 2)

The JSDOM harness cannot see an animation and cannot see a layout, so the
motion itself is pinned in a real browser:
`admin/e2e/navigation/` (run it with
`pnpm --filter @nessie/admin test:e2e:navigation`).

What it does, per run:

- starts the real API on 5454 and the real admin on 5455 against
  `DATABASE_URL` — a server already listening on either port is used as it
  stands, so it costs nothing next to a running `pnpm dev`;
- signs in through the product's own doors — the one-time owner bootstrap on
  a fresh database, `GET /api/auth/dev-login` on a database that already has
  an owner — and seeds one organisation with its project and two channels
  through `POST /api/channels`;
- drives Chromium (`playwright-core`, no `@playwright/test`) at 390×844,
  768×1024 and 1280×800.

What a case asserts. It **freezes the real animation** rather than timing it:
a `requestAnimationFrame` watcher pauses every animation that appears on a
`[data-phone-navigation-layer]`, then `currentTime` is seeked to 0 %, 50 %
and 100 % and each frame is measured with `getBoundingClientRect()`. There is
no sleep anywhere in the measurement. `document.getAnimations()` is the seam
on purpose: it sees a CSS keyframe animation and a Web Animations one alike,
so the suite survived the step-2 rewrite unchanged. Every frame also asserts
`scrollLeft === 0` on `.phone-navigation-viewport` and on every
`.phone-navigation-screen` — that is §2's bounce, measured.

| case | viewport | what it pins |
| --- | --- | --- |
| `phone-push` | 390×844 | tapping a channel row: the conversation travels 100 % → 0, the list 0 → -28 % |
| `phone-back` | 390×844 | header Back: the conversation travels 0 → 100 %, the list -28 % → 0 |
| `phone-edge-swipe` | 390×844 | a touchscreen swipe from x=8 to x=300 commits Back; the settle runs from exactly the released displacement to the ends |
| `phone-tab-switch` | 390×844 | Messages → Files moves nothing: no layer animates, the screen's rect is unchanged |
| `tablet-select` | 768×1024 | selecting a channel in the split stack is an in-place swap: one layer, nothing animates, the columns keep their geometry |
| `desktop-select` | 1280×800 | the same at desktop width |
| `tablet-split-push` / `desktop-split-push` | 768×1024 / 1280×800 | Agents → the designer pushes inside the detail column: the designer travels 100 % → 0 of the column, the list 0 → -28 %, the pinned sidebar never moves |
| `phone-cold-start` | 390×844 | a cold link to a conversation seeds the channel list beneath it; header Back slides the conversation away over that list (0 → 100 %, -28 % → 0) |
| `phone-intent-strip` | 390×844 | `#trigger-<id>` and `?messageId=` are consumed and stripped with a replace: the address settles on the screen, the linkable `?tab=` stays, and browser Back lands on the stripped address |

Each transition case navigates once per saved frame, deliberately: the stack
closes its own transition on a fallback timer shortly after the animation's
nominal end, so one run cannot hold a frozen frame for three screenshots —
while all three fractions are measured inside one synchronous `evaluate`,
far inside that window. Frames land in `e2e/screenshots/navigation/<case>/`
(`00-start`, `01-midway`, `02-settled`) for the eyeball rule in `AGENTS.md`.

Where it runs:

- **CI** — the `navigation-e2e` job in `.github/workflows/ci.yml`: Postgres 16
  + pgvector, `prisma migrate deploy`, a built admin bundle
  (`NAV_E2E_ADMIN_MODE=preview`), `pnpm exec playwright-core install
  --with-deps chromium`, and the frames uploaded as the
  `navigation-transition-frames` artifact.
- **Locally** — `DATABASE_URL=… pnpm --filter @nessie/admin test:e2e:navigation`.
  Useful switches: `--case=phone-push` / `--viewport=phone` to narrow,
  `CHROMIUM_PATH` to name a browser binary, `NAV_E2E_ADMIN_MODE=preview` to
  serve `admin/dist` instead of the dev server, `NAV_E2E_SERVER_LOGS=1` to see
  the servers' output, `NAV_E2E_KEEP_SERVERS=1` to leave them up.
  With no reachable database the suite prints why and exits 0 — everything it
  asserts needs a running product, and a red run that only means "no Postgres
  here" teaches people to ignore it.
- **On device** — iPhone and iPad checks stay manual; the plan lists them per
  step.

**What it caught first.** `phone-back` was red on its first run: the route
pop painted only the returning list, because `advancePhoneNavigationStack`'s
same-depth branch truncated every entry above `currentIndex` on the first
re-render of the destination (its data settling is enough), and after a Back
the outgoing screen *is* that entry. The stack now refreshes a same-route
re-render in place and releases the entries above only for a sibling swap;
`admin/test/phone-navigation-stack.test.ts` replays the route mid-Back to
pin it. The JSDOM stack test had passed because it never replayed a route —
the browser suite is what sees it.

### Gates — **built** (step 15)

The framework stays the only way because a second one cannot compile, lint or
test green. Each gate below ships with an allowlist that only ever shrinks —
seeded from real offenders at the time the gate landed, deleted line by line
as the parallel conversion work lands elsewhere, never regrown, never a flag
day.

| gate | mechanism | allowlist lives in |
| --- | --- | --- |
| literal z-index (`z-[n]`, `z-N`, `zIndex:`, `z-index:`) outside `var(--layer-*)` / `OVERLAY_LAYER` | `scripts/lint-layers.mjs` (`pnpm lint:layers`, wired into root `pnpm lint`) | a `Set` of file paths at the top of the script |
| `scrollIntoView(` inside a `useLayoutEffect` callback | ESLint `no-restricted-syntax`, `eslint.config.js` | none needed — zero uses today |
| `autoFocus` / `.focus()` without `preventScroll` on a screen root (`admin/src/pages/**`, `admin/src/layouts/**`) | ESLint `no-restricted-syntax`, `eslint.config.js` | the block's own `ignores:` list |
| `navigate(` / `useNavigate` outside `admin/src/navigation/**` | ESLint `no-restricted-syntax`, `eslint.config.js` — declared **off** until controller.push exists (step 13) | n/a while off |
| `overflow: hidden` / `overflow-hidden` on a stack container | source-regex test, `admin/test/navigation-gates.test.ts` | none needed — the four containers are pinned clean |
| a new `phone-navigation-*`/`kb-view-*` `@keyframes`, or a `transition:` inside a `.phone-navigation-*` rule | source-regex test, `admin/test/navigation-gates.test.ts` | an array in the test file |
| every `router.tsx` path present in the surface registry | `scripts/lint-navigation-surfaces.mjs` (`pnpm lint:navigation-surfaces`), also `admin/test/navigation-surfaces-total.test.ts` | n/a — the registry is total by construction (§4.1) |
| a `role="dialog"` surface without `Dialog`/`ConfirmDialog`/`Sheet`/`Popover`/`useOverlay(` | source-regex test, `admin/test/navigation-gates.test.ts` | an array in the test file, self-checked against `git ls-files` |
| `animate-pulse` markup outside `components/primitives/Skeleton.tsx` | source-regex test, `admin/test/skeleton.test.ts` | an array in the test file, self-checked against `git ls-files` |
| a facade `useQuery` keyed by, or gated on, an entity id without `placeholderData: keepPreviousData` | source-regex test, `admin/test/skeleton.test.ts` | an array in the test file (billing only, §12) |
| a `/api/` URL literal inside `navigation/prewarm.ts`, and every wired row spreading `prewarmRowHandlers` | source-regex test, `admin/test/prewarm.test.ts` | the wired-row list in the test file |

## 12. Focus, announcement and scroll — **built** (step 11, the settle)

The stack settles a slide, never mid-slide (`navigation/settle.ts`):

- **Push**: focus the landed screen's `h1` with `preventScroll` (a focus
  that scrolls is how the bounce was made; the heading gets `tabindex=-1`
  if it lacks one). **Pop**: focus the retained screen's `h1` only if the
  popped screen held focus, so a person tabbing through a list keeps their
  place when a detail above it closes. Overlays move focus in and restore it
  on close through `useOverlay` (§7).
- **One polite live region** (`PhoneNavigationProvider`,
  `data-navigation-announcer`) announces the settled screen's heading,
  debounced, so two settles inside the window announce once with the later
  title. Overlays announce through their own dialog semantics, never both.
- **A push blurs the active element** explicitly before the slide, so a
  composer's soft keyboard closes on purpose rather than because the
  outgoing layer became inert.
- **Scroll**: the browser's restoration is `manual` at the root
  (`main.tsx`); retained layers keep their position for free, a fresh push
  starts at 0. Per-layer `useScrollMemory` on `split` and the second-scroller
  lint are still planned.
- Pinned by `admin/test/navigation-settle.test.ts`.
- **`aria-current="page"`**: the rail item and every section-sidebar row that
  carries an `active` class set it through one shared helper,
  `sidebarAriaCurrent` (`layouts/admin-shell/SidebarRow.tsx`) — the rail,
  `SidebarNav` and its four section components, `AdminSidebarNav`,
  `KnowledgeSidebarNav` (plus `KnowledgeSpaceList`, shared with the project
  Docs tab), `ProjectsSidebarNav`, and the personal-assistant sidebar entry.
  The one `NavLink` row (Knowledge's "All dashboards") already gets it for
  free — React Router stamps `aria-current="page"` on an active `NavLink`
  itself, so that row needed no change.
- **Skip link**: `<SkipToContentLink />` (`navigation/SkipToContentLink.tsx`)
  is the first element inside the authenticated shell, before the top bar and
  rail. Visually hidden (Tailwind `sr-only`) until it receives focus
  (`focus:not-sr-only`), styled from theme tokens only per CLAUDE.md →
  Theming. It targets `#admin-shell-main` — both `<main>` branches in
  `AdminShellLayout` (phone and split) carry `id={SHELL_MAIN_ID}` and
  `tabIndex={-1}` so a non-heading landmark can still take programmatic
  focus.
- **`forced-colors`** (Windows High Contrast): `styles.css` carries one
  `@media (forced-colors: active)` block giving the four places that carried
  their state through colour alone a `Highlight`/`CanvasText` border or
  outline instead — `TabBar`'s `.tabbar-indicator` (its ring was a
  `box-shadow`, which forced-colors discards), the rail's active tile (its
  `color-mix` background collapses to every other tile's forced background),
  every `:focus-visible` ring (an accent outline forces to ordinary text
  colour otherwise), and `.admin-card` / `.admin-input` borders (a
  `var(--sep)` border can force to the same colour as the card's own
  background).
- **Soft keyboard inset**: one `visualViewport` resize listener for the
  whole shell (`navigation/keyboard.ts` `useKeyboardInset`, mounted once in
  `AdminShellLayout`) sets `--keyboard-inset` (px) on the root while an
  on-screen keyboard is open — the gap between `window.innerHeight` and the
  shrunk `visualViewport`, ignoring deltas under 60px (browser chrome, not a
  keyboard). The channel composer's container and the standalone
  new-conversation composer read it (`padding-bottom` /
  `margin-bottom: var(--keyboard-inset, 0px)`) so the active composer stays
  above the keyboard instead of sliding under it; the message composer's
  editable region carries `enterKeyHint="send"`. Every overlay panel that
  sized with a bare `vh` unit — nine dialogs/popups plus two `styles.css`
  rules — now sizes with `dvh` (the dynamic viewport, which a soft keyboard
  can shrink; the static `vh` cannot), including the shared `Dialog`'s `xl`
  size.
- **Scroll owners on split**: `useScrollMemory` already covered the two
  lists that swap for their own detail at stack depth 1 on `split`
  (`ColumnBrowserColumn`, `AgentsList`, keyed per list identity). The channel
  list and the knowledge tree — the persistent per-section sidebars
  (`SidebarNav`, `KnowledgeSidebarNav`) — get the same treatment, keyed by a
  constant per-section id (`sidebar:channel-list`,
  `sidebar:knowledge-tree`) rather than a pathname: unlike a route's own
  screen, these single scrollers are shared across every route inside their
  section and only lose position when the section itself swaps out for
  another (Channels → Knowledge → Channels) and back.
- Pinned by `admin/test/a11y-navigation.test.ts`.

## 13. Interruption and visibility — **built** (step 14)

- **A navigation arriving mid-slide settles the running slide first**: its
  end pose commits, its released entries drop and its settle runs, then the
  new transition starts from a clean stack. Nothing preempts a half-finished
  pose, and no stale entry survives an interrupted Back.
- **A hidden document never holds a half-finished pose**: a slide that
  starts while the tab is hidden commits at once (0 ms through the same
  path), and hiding the tab mid-slide finishes it, so a tab that comes back
  is already settled. `redirect()` (§4) already waits for the stack.
- **Pull-to-refresh is the web's.** In the native shell a Root or Detail
  page scroller that holds no message feed (`data-message-feed`) offers a
  pull from its top; past the threshold it asks the shell for the one full
  refresh it already has (`nessie:full-refresh`), the same on iOS and
  Android. Nested screens, flows, stages, seeded layers, boards, editors
  and feeds never offer it. The native WebView's own pull-to-refresh is
  turned off with the mobile step (`navigation/pull-to-refresh.ts`).
- Pinned by `admin/test/navigation-interruption.test.ts` and
  `admin/test/pull-to-refresh.test.ts`.

## 14. Arriving with content — **built** (step 10)

The stack slides for 300 ms; the destination has to have something to show
for it. Four pieces, plus one cache underneath them all.

- **Prewarm on intent** — `admin/src/navigation/prewarm.ts`. `usePrewarm()`
  returns `prewarm(to)`; `prewarmRowHandlers(prewarm, to)` is what a row
  spreads onto its element, firing on `pointerdown`, `touchstart` and `focus`
  — all *before* the click, so the destination's first query is in flight
  before the slide starts. The registry is six entries, keyed by destination
  path: `/channels/:id` → that channel's first messages page (its thread id
  read out of the already-cached channel list), `/projects/:id` (and its six
  section routes) → the board, `/agents/:id` → the agent's status,
  `/dashboards/:id` → the dashboard, `/knowledge-base/spaces/:id` → the space
  and its pages, `/apps/:slug` → the app. Each entry calls the **exact
  `fetch*` function the destination's hook calls**, under the exact key from
  `lib/query-keys.ts` — a URL spelled here would be a second fetcher, and the
  first divergence would fill the cache under the right key with the wrong
  shape (pinned: `prewarm.ts` contains no `/api/` literal). No hover storms:
  a per-hook TTL map (`PREWARM_TTL_MS`, 10 s) makes a focus/pointerdown/touch
  burst one request, and `prefetchQuery` honours the same `staleTime` so a
  warm entry costs nothing. Wired to the sidebar channel/DM/project/starred
  rows, the knowledge space list, the agents table, the app cards and the
  dashboards list.
- **Sibling swaps keep previous data.** Every facade `useQuery` that is keyed
  by an entity id, or gated on one (`enabled: Boolean(id)`), passes
  `placeholderData: keepPreviousData`, so channel A → B shows A's feed until
  B's arrives instead of flashing empty. Pinned by
  `admin/test/skeleton.test.ts`; the one exemption is billing, whose keys are
  scoped per UOA org/team and must never reuse another team's projection.
  The corollary is that **`isSuccess` no longer means "this entity's data"** —
  a query serving placeholder data reports success — so a consumer that acts
  on identity guards with the id: the thread read marker refuses while its
  messages are placeholders (`isConversationReadReady`'s
  `messagesArePlaceholder`, or it would advance the new thread's cursor to a
  message it never held), and the dashboard editor seeds its draft layout only
  from `dashboard.id === dashboardId`.
- **Pending is never "empty".** The three lists that asserted "nothing here
  yet" while still loading now render the skeleton: the knowledge space list
  (both its sidebar and the project Documents tab), the triggers column, and
  the workflows column. Each takes the fact from its own query, and a *disabled*
  query — the non-owner case, whose refusal is the page's own gate — is
  deliberately not "loading".
- **One `Skeleton`, four page types** —
  `admin/src/components/primitives/Skeleton.tsx`: `list`, `detail`, `feed`,
  `board`, plus `SkeletonBlock` for the placeholders that are one sized
  rectangle (a dashboard tile holding its grid cell open, a pill standing in
  for a count). A screen picks the variant its content is shaped like, so the
  reveal lands on a plausible shell. It replaced three systems on two
  different tokens (`AppSkeletons`, `SectionSkeleton`, the agents/sessions
  table rows, the dashboard rectangle); `admin/test/skeleton.test.ts` pins
  that no other file under `admin/src` declares `animate-pulse` markup, with
  two allowed exceptions that pulse a live status rather than a placeholder.
- **One blob cache** — `admin/src/lib/blob-cache.ts`, behind
  `useAuthedObjectUrl` / `useAuthedObjectUrlFromPath`. An authed image cannot
  be a plain `<img src>`, so every avatar, app icon and attachment preview was
  fetched and decoded again on *every mount*. The cache is a bounded LRU
  (96 entries) of object URLs keyed by request path plus the caller's pinned
  MIME, reference-counted: an entry is revoked only when evicted, and only an
  entry nobody holds may be evicted — a `blob:` URL dropped without revoking
  leaks for the life of the tab, and one revoked under a live `<img>` renders
  as a broken image. A hit is read during render (`peekBlobUrl`), so a
  retained or re-entered screen paints its faces on the first frame; the
  resolved URL carries the key it belongs to, so a path change reads as a miss
  on that same render rather than one effect later. It is deliberately **not**
  keyed by token — the bytes stay valid across the 30-minute rotation that
  used to re-fetch every image on screen — and it is cleared with the query
  cache when the session ends.

## 15. Still planned

Everything the plan (`docs/plans/2026-09-01-navigation-motion-system.md`)
names is built and described above, except these, each noted where it
belongs and listed here so nothing hides:

- The centred-panel rendering of a Flow on `split` (§7).
- Per-layer `useScrollMemory` on `split` and the second-scroller lint (§11).
- The remaining `NAVIGATION_KEYFRAME_ALLOWLIST` / `BESPOKE_DIALOG_ALLOWLIST`
  entries in `admin/test/navigation-gates.test.ts`: each is one conversion
  away from deletion, and the gate refuses new entries.
