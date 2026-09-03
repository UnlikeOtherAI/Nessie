# The framework

Chapter of [One navigation framework](overview.md). The containers, the motion,
the registry, Back, layout, overlays, headers, the native shell contract, and
the gates that hold them together.

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
`/ops/usage` 2 with `parent: 'origin'` and Admin as its fallback (decided at
build: `/ops` is super-admin-only while usage is owner-only, so Back from a
cold link must never land on a refusal); `/dashboards` stays 1 under Knowledge. A row may declare
`parent: 'origin'` for a Detail reachable from every section (`/alerts`,
`/feedback` — today in no nav and no prefix list, reached from the bell, the
account menu and the iPad toolbar's help action): Back pops to the previous
in-app entry when the ledger has one, else replaces with the Admin root,
which is where both are added to the admin nav.

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
  one `NavigationStack` **per detail-column owner**. `AdminShellLayout` has a
  single `useOutlet`, so the shell mounts the stack for the families whose
  list column is the shell's own sidebar (Channels, Projects, Settings and
  the admin pages); Knowledge, the four column-browser pages and Dashboards
  own their list columns inside the page and mount the same `NavigationStack`
  around their own detail column. Detail → Detail sibling swaps are instant;
  Detail → Nested detail pushes inside the column. Flows open as centred
  panels. The 900–1279 px band is `split`; the thread panel there is a
  `Sheet`. The native back/forward swipe is turned off on iPad and
  large-phone landscape (`webview-back-gesture.ts` gate extended) **only once
  `ScreenHeader` (step 9) has put a Back in every screen's leading lane**,
  because the iPad toolbar is the only on-screen Back there today.

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
The viewport test harness is JSDOM, which has no Web Animations API — today's
swipe passes only because `animateLayer` bails when `layer.animate` is
missing — so step 2 gives the harness a fake `animate()` timeline that tests
drive to completion, and a route push that cannot animate falls back to an
immediate commit rather than hanging.
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
the caller is the header button, the edge swipe, Android hardware Back,
Escape, the browser's own Back, or a mouse side button. Order: the topmost
open overlay → the deepest nested stage → the route's parent (pop when the
ledger's previous entry is it, else replace) → the section root. Today
`PhoneNavigationButton` and `performBack` each re-implement that order and
merely agree by convention. **The desktop top bar and the iPad toolbar are
history controls, not Back**: their Back/Forward walk the ledger across
sections, which `resolveBack()` deliberately never does. They keep that job,
but they read the one ledger instead of two private counters, and they
consult the registry first, so a toolbar Back over an open Knowledge editor
closes the editor rather than popping the route underneath it.

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
produce for same-document navigation (blank or stale frames, reported across
the Cordova and Ionic WKWebView trackers; one unanswered Apple forum report
describes iOS 17.5.1 jumping to the first entry). That is why phones already
turn it off. Decision: **the web gesture is the gesture**, on every layout
that pushes, and it is finished to native feel:

- settle duration scales with remaining travel (a flick from 90 % must not
  take as long as a release at 10 %), on `--nav-easing`;
- the revealed screen gets a dimming scrim proportional to reveal, alongside
  the existing 28 % parallax and edge shadow;
- a light haptic at commit-threshold crossing and on sheet snap, through a
  new `nessie:haptic` bridge message to `expo-haptics`;
- the gesture is refused, as today, on editable targets, inside horizontal
  scrollers, and while a transition runs. Today it is also refused whenever
  any local Back owner is active (`enabled: … && !localBackActive`), which
  is most nested screens; that gate becomes `resolveBack()?.swipeable`, so
  nested stages, sheets and modals are swiped closed, and only an owner that
  must not be (an editor mid-flush, a streaming document) opts out;
- the same gesture drives the detail column on `split`, and iPad and
  large-phone landscape turn the native swipe off (§7);
- reduced motion keeps every threshold and sets the settle to 0 ms.

**Cancel and Close stay distinct from Back.** A flow's Cancel discards and
closes; a header never shows Cancel beside a Back that does the same thing
(the designer renders both today). Close-X closes an overlay. Back is the
leading-lane chevron, and there is exactly one per screen.

### 4.8 Scroll and focus discipline

- `.navigation-stack`, `.navigation-layer`, `main`, and the column-browser
  wrapper are `overflow: clip`. The page scroller stays
  `overflow-x: hidden; overflow-y: auto`: `clip` on one axis computes to
  `hidden` when the other axis scrolls, so it gains nothing there, and the
  four clipped containers are the ones a descendant could scroll.
- `TabBar` scrolls its own track (`track.scrollLeft`), never `scrollIntoView`.
- `useStackSettled()` resolves after the entering layer's transition finishes.
  `autoFocus` on a screen becomes `focus({ preventScroll: true })` after
  settle; the composer uses it so the keyboard does not rise mid-slide.
- `useScrollMemory` is wired into every stack layer by key (it exists with two
  call sites, one effective: `ColumnBrowserColumn` takes a key nobody passes,
  so it is disabled there).
- Horizontal scrollers that legitimately own an edge drag (Kanban pages, the
  Knowledge columns strip on `split`) carry `data-navigation-swipe-ignore`; the
  gesture's existing target gate reads it.

### 4.9 One header per page type — **built** (step 9, `docs/navigation/overview.md` §9)

Nine header shapes exist (`ResponsivePageHeader` and its six wrappers, the
thread panel's, the info flow's, the compose page's, and seven hand-rolled
hero headers), at three heights (50, 58, content-driven), seven title sizes
(13 to 24 px), and four action-button systems. Five states return before any
header, so a phone has no Back there: `OwnerGate` refusals on Audit, Policy,
Tools, Triggers and Ops usage, the super-admin refusal on `/ops`, the agent
designer's loading branch, and the dashboard's loading and not-found
branches. No screen sets `document.title`, and nothing tells the native
chrome what screen it is on.

Rules:

- **`ScreenHeader` is the one header**, built on `ResponsivePageHeader`'s
  measured-overflow lane, parameterised by page type: Root (title, menu
  doorway, section actions), Detail and Nested detail (Back, entity title,
  eyebrow, actions), Tab host (the Detail header plus the `TabBar` row),
  Flow (Back or Close, step title, primary action), Overlay (title, Close).
  Height is one token; the title is one size per tone; actions are
  `PageHeaderAction` values that overflow into More by measurement, never
  raw buttons. The seven hero headers keep their content (avatar, status
  line, description) as a **subtitle slot** the header already lacks, not as
  a second header.
- **The header is always rendered.** Loading, empty, not-found and refused
  states render inside the screen body under the same header, so Back never
  disappears. `OwnerGate` wraps the body, not the page.
- **Every screen has one `h1`**, the header title, with `tabIndex={-1}` so it
  can take focus (§4.12). Nested details render `h2`. Today twelve routes
  have an `h1`; the rest have `h2` or nothing.
- **The header sets `document.title`** (`<screen> · <section> · Nessie`) and
  posts `nessie:screen` to the shell (§4.16), so the browser tab and the
  native chrome name the screen.

### 4.10 Arriving with content — prewarm, previous data, one skeleton

The stack slides for 300 ms; today the destination often has nothing to
show for it. No `prefetchQuery` or `ensureQueryData` exists anywhere, no
per-id detail query keeps previous data, three unrelated skeleton systems
use two different tokens, three lists assert a false "nothing here yet"
while loading (Knowledge, Triggers, Workflows), two pages return bare text
with no chrome (dashboard detail, agent detail on a cold cache), and every
avatar is re-fetched and re-decoded on every mount with no cache.

Rules:

- **Prewarm on intent.** Every row that navigates already holds the
  destination id at render. `controller.push()` takes an optional
  `prewarm(queryClient)`; list rows call it on `pointerdown` (and on hover on
  fine pointers), so the destination's first query is in flight before the
  slide starts. One helper per family (`prewarmChannel`, `prewarmProject`,
  `prewarmApp`, `prewarmAgent`, `prewarmSpace`, `prewarmDashboard`).
- **Sibling swaps keep previous data.** Per-id detail hooks use
  `placeholderData: keepPreviousData`, so channel A → B shows A's feed until
  B's arrives instead of an empty list. The apps search list already does
  this; it becomes the rule.
- **Pending is never "empty".** A list hook exposes `isPending`; the empty
  state renders only when the query has settled with nothing.
- **One `Skeleton`** on one token, with row, card, header and paragraph
  shapes; each page type declares its skeleton so the slide always reveals a
  plausible shell. `AppSkeletons`, `SectionSkeleton` and the ad-hoc dashboard
  rectangle fold into it.
- **One blob cache** behind `useAuthedObjectUrl`, keyed by attachment id
  with reference counting, so a face that was in the sidebar a second ago is
  not fetched again for the header.

### 4.11 Drafts — auto-save first, never a save button, never a confirm

Nothing in the admin asks a person "discard changes?" about their own
draft. Leaving a screen is safe because the draft is already persisted. The
workflow designer is the model today (local draft for a new item, debounced
server autosave for an existing one, a signature diff so nothing is saved
twice, no retry of a payload the server rejected). Everything else keeps
state in memory and loses it on reload; the channel composer's reset on
channel change clears everything except the text and the staged
attachments, so both leak into the next channel; the two DM info drawers and
the thread panel mount their own composers, and the thread panel's unmounts
on close; message inline edit discards on Escape; and the task dialog, agent
designer, knowledge editor, trigger editor and dashboard edit mode discard
silently.

Rules:

- **`useDraft(key, { local, server })`** is the one primitive. It buffers to
  `localStorage` under a stable key (`draft:<surface>:<entityId>`) on a
  short debounce, and flushes to the server on a longer one where an
  endpoint exists. The key is the entity, so a composer draft is per
  channel, a task draft per task, an editor draft per page, and the DM info
  drawers' composers are keyed by their target too. Mounting with a draft
  present restores it; a successful send or save clears it.
- **Surfaces adopt it in risk order**: thread reply composer, channel and DM
  composers (keyed by channel, staged attachments included), task dialog,
  message inline edit, agent designer, knowledge page editor, trigger editor,
  dashboard edit mode, then the settings forms.
- **The API becomes safe to auto-save against.** Create endpoints take a
  client idempotency key (`POST /api/threads/:id/messages` first, since a
  retried send duplicates today); the update routes for dashboards and
  workflows, which already carry `Dashboard.revision` and
  `WorkflowTemplate.version`, accept `If-Match` and answer 409 on conflict.
  Knowledge pages have no current-revision column (`versionNumber` lives on
  the per-version row), so the page row gains one in the same change. A
  conflict surfaces in place as a choice, never a blocking dialog.
- **Save buttons go.** Where a server flush is not possible (a create form
  with required fields not yet valid), the primary action stays, but it is
  the only one, and leaving keeps the local draft.
- **The one confirm that stays** is `useLeaveGuard`'s, and it is already the
  only one: an agent-authored document still streaming into a thread. That
  is not a person's draft; it is the reader leaving mid-write.

### 4.12 Focus, announcement, title

Nothing manages focus on navigation. After a push focus is wherever the
outgoing layer's `inert` left it, usually `body`. There is no route
announcer; the live regions that exist (the toast stack, the session debug
dialog, the avatar generation indicator, a handful of `role="alert"` errors)
are all local widget feedback. `aria-current` exists only on the mobile web
tab bar; the rail and every section sidebar signal the active item with a
class alone. There is no skip link. Reduced motion is honoured;
`forced-colors` is not.

Rules, per page type, executed by the stack after settle (never mid-slide):

- **Push** (Detail, Nested detail, Flow as screen): focus the new screen's
  `h1` with `preventScroll`. **Pop**: focus the retained screen's `h1` only
  if the popped screen held focus. **Tab host**: `TabBar` keeps its own
  roving focus. **Overlay**: `useOverlay` moves focus in and restores it on
  close, for every overlay, including the three that skip it today.
- **One polite live region** in the shell announces the screen title on
  every settled push and pop, debounced; overlays announce through their
  dialog semantics instead, never both.
- **`aria-current="page"`** on the rail and every sidebar row that carries
  an active class; one skip link to `main`.
- **`forced-colors`**: selection pills, the rail's active tile, focus rings
  and card borders get a non-colour signal.

### 4.13 Scroll

Retained layers keep scroll for free on `single`; on `split` the outlet
remounts and only two lists remember their position. The browser's own
restoration is never disabled and fights the app's. Every `NavigationStack`
layer registers `useScrollMemory` by stage key; a fresh push starts at 0; a
pop keeps what it had; a sibling swap resets through the existing
`useStickToBottom` reset key; `history.scrollRestoration = 'manual'` at the
root. Each page type names its scroll owner (the layer's page scroller or
one inner scroller), and the overflow lint (§4.18) refuses a second.

### 4.14 Soft keyboard

A composer with focus loses it on a push only because the outgoing layer
becomes `inert`. That becomes explicit: the controller blurs the active
element before a push or overlay open, on every layout. A pop never
reopens the keyboard. A `visualViewport` resize listener keeps the active
composer above the keyboard; every overlay panel sizes with `dvh` — nine
overlays and two stylesheet rules still use `vh` today, including the shared
`Dialog`'s `xl` size; the composer gets `enterkeyhint="send"`.

### 4.15 Haptics, pull-to-refresh, interruption

- **Haptics.** No haptics module exists; the one place that wants feedback
  (`IncomingCallProvider`'s `navigator.vibrate`) is silent on iOS. `expo-haptics`
  joins the shell; `nessie:haptic { kind }` joins the bridge with a typed
  guard like the existing connector-authorization message; the admin posts
  it through one `haptic(kind)` helper. Light on swipe-commit and sheet
  snap, selection on tab change, warning on the call ring, and the
  `navigator.vibrate` call becomes the web fallback.
- **Pull-to-refresh.** The WebView's native `pullToRefreshEnabled` is
  iOS-only, forces `bounces`, reloads the whole document from any screen and
  posts nothing to the web; Android has no pull-to-refresh today. It is
  turned off, and refresh behaves the same on both platforms for the first
  time: the web owns the gesture at the top of a Root or Detail page scroller
  that contains no message feed, and posts `nessie:full-refresh` (which
  already exists). Boards, editors, any surface embedding a feed (the
  conversation, the thread panel, the Threads inbox whose cards embed full
  feeds) and scrolled overlays never offer it. `overscroll-behavior-y:
  contain` moves onto every inner scroller, not only the page shell.
- **Interruption.** During a slide both layers are `inert`, so taps are
  dropped, which is right. A second navigation preempts the first without
  cleaning its stack entries; a hidden tab lets the fallback timers finish a
  transition the compositor never drew. The controller queues navigations
  that arrive mid-transition and applies them after settle; `redirect()`
  already defers; the stack pauses its animations on `visibilitychange` and
  resumes them, and the fallback timers pause with them.

### 4.16 The native shell contract

The shell re-derives from the pathname what the admin already knows: which
tab a route belongs to (a hand-copied prefix list), whether it is a root (a
five-path set), and it has no screen title at all; badges exist for three of
five tabs. One message replaces the guessing:

```
nessie:screen { path, title, section, screenType, depth, hasBack }
```

**Built** (step 9): posted by `NativePhoneNavigationBridge` beside
`nessie:route` and `nessie:back-state`, read straight off the surface
registry. The page type travels as `screenType`, because `type` is the
message's own discriminant; `nessie:attention` now carries `badges` keyed by
the same section names. The exact shape is in `docs/navigation/overview.md` §10.

The shell's path matching (`tabIndexForPath`, the `TABS[].matches`
predicates and `isNativePhoneTabRootRoute`) is deleted; the `TABS` table
itself stays for titles and paths. The shell keeps a **last-known section**
from the latest `nessie:screen` so the tab index is right before the first
message on a cold start and after the search overlay closes.
`nessie:attention` carries a badge per section. `nessie:haptic` (§4.15) and
the removal of native pull-to-refresh complete the contract; everything else
on the bridge is unchanged.

### 4.17 Deep links and cold starts

Twenty-three entry points land on a screen with no stack beneath it: web
and native push, the desktop notification, the auth and billing returns, and
the intent params (`spaceId`, `pageId`, `view`, `tab`, `connect`,
`messageId`, `incomingCall`, `acceptCall`, `executorId`, `accessChange`,
`promotion`, `filter`, `query`, `mode`, `#trigger-`, `#confirmationToken`).
Some strip themselves after use, some are linkable by design, some never
clear though they look one-shot (`uoa_billing`, `#trigger-`), and every
`<Navigate>` redirect drops `state`.

Rules:

- **Seed the stack.** On a cold start (a single-entry ledger, or an unknown
  POP) the controller walks the registry's `parentOf` chain from the landed
  route to its Root and seeds those entries beneath it, so Back and the
  edge swipe reveal the same screens a real navigation would have. Seeded
  entries are **render-only**: they populate the retained layers and the
  parent chain, never the ledger's history keys, because no browser history
  exists behind a cold start. Back from a seeded stage is always `replace`;
  `pop` stays reserved for a real previous entry. Roots seed nothing;
  `parent: 'origin'` rows seed their section root, which is also where they
  land once the ledger has reset on an unknown POP.
- **Intent params are declared, not improvised.** Each registry row lists
  its intent params as `consume` (stripped by `replace` after the controller
  hands them to the screen, in one place, never in six effects) or `state`
  (linkable, kept). `uoa_billing` and `#trigger-` become `consume`; the
  executor hash token and its three params become one nested stage.
- **Redirects forward state.** Every `<Navigate>` passes `state` through,
  and `/` resolves the native pending push path as today.
- **Origin travels explicitly** where the registry cannot know it: a channel
  opened from a project carries `from` in navigation state, and the seeded
  parent is the project; a cold link without it seeds Channels.
- **The desktop shell gets a pending path** like the native one: today the
  Tauri init script dispatches `nessie:desktop-notification-open` at once and
  `NotificationsProvider` only listens once mounted, so a click on a quit app
  is lost between the two. The path is retained on `window` and replayed by
  the root redirect, as the native pending push path is.
- **Every other route-changing effect goes through the controller**: the
  large-phone-landscape rotation redirect in `PhoneNavigationProvider`, the
  team switch and logout (both reset the ledger and any seeded stack,
  and say so), the auth completion landing (a cold start into a Detail is
  seeded like any other), and the invite alerts' accept action from the bell
  popover.

### 4.18 Gates — the framework stays the only way

The repo already has the three shapes: file-scoped ESLint bans (the
`useMediaQuery` `no-restricted-imports` rule, scoped by `files:` and
`ignores:`), a breakpoint lint script with an allowlist, and source-regex
tests.
Each gate ships with the step that makes it satisfiable, with an allowlist
that shrinks to empty, never a flag day:

| gate | mechanism |
| --- | --- |
| `navigate(` / `useNavigate` outside `admin/src/navigation/` | ESLint `no-restricted-syntax`, allowlist |
| literal z-index (`z-[n]`, `z-index:`) outside the layer tokens | `scripts/lint-layers.mjs`, modelled on `lint-breakpoints.mjs` |
| `scrollIntoView` inside `useLayoutEffect` | ESLint AST selector |
| `overflow: hidden` / `overflow-hidden` on a stack container or a second scroller in a layer | source-regex test on the stack components |
| `autoFocus` on a screen root; `.focus()` without `preventScroll` in a screen | ESLint `no-restricted-syntax` |
| a new `@keyframes` for navigation; a `transition-*` utility on a stack layer | count assertion on `styles.css` |
| every `router.tsx` path present in the surface registry, every registry row typed | `scripts/lint-navigation-surfaces.mjs` in `pnpm lint` |
| a bespoke overlay without `useOverlay` | source-regex test over `role="dialog"` files |

### 4.19 Verification — a transition suite that sees the animation

The jsdom harness cannot see animations; Playwright is not in CI; nothing
diffs pixels. The suite: Postgres + seed + the two dev servers (the smoke
job's shape), Chromium installed in a new CI job, viewports 390×844 and
768×1024 and 1280×800, and for each transition the test freezes the real
animation with `document.getAnimations()` at 0 %, 50 % and 100 %, asserts
positions and `scrollLeft` numerically, and saves the three frames as
artifacts for the eyeball rule in `AGENTS.md`. The repro script from §1
becomes its first case. Device checks on iPhone and iPad remain manual and
are listed per step.

