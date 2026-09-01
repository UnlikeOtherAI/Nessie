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

## 4. Registry, controller and Back — **built** (steps 3–4, wiring in progress)

### 4.1 The surface registry — `admin/src/navigation/surfaces.ts`

One declarative table classifies every route; the vocabulary a row is written
in — the page types of §1 and the row shape — is `navigation/page-types.ts`
beside it. A row is: `pattern`, `type`
(§1, plus `redirect`), `section`, `depth`, `root`, `identityOf` / `keyScope`
(which screens are the *same* screen, so a sibling swap swaps content in
place), `parentOf(match)` → `{ label, pathname }` (what Back returns to, and
what it announces), and optionally `parent: 'origin'`, `contextualList` or
`flowPresentation`. Everything else derives from it:
`phone-navigation.ts` is now a thin adapter over
`matchSurface` / `surfaceScreen` / `surfaceParent` / `surfaceRootPath`, so the
stack, the ledger, `resolveBack()`, the Back doorway and the native bridge all
read one table.

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

- **A committed swipe gives one `light` haptic** (`lib/haptics.ts`, §6) at
  the moment the settle lands and the route is about to change. A cancelled
  swipe and a tapped Back give none.

Planned in this step: `BackButton` as the single glyph in every header on
every layout.

## 5. Layout — **built** (step 5, the decision; stacks per column follow)

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

Planned in this step: `NavigationStack` in the shell's detail column and in
the page-owned detail columns on `split`; the thread panel as a nested stage
on `single` and a `Sheet` on `split`.

## 6. Native shell contract — **built** (the two bridge pieces)

The two `mobile/` ↔ admin bridge facts the plan (§4.7, §4.15, §4.16, §7)
calls out as their own pieces are **built**; the rest of §4.15/§4.16 (the
`nessie:screen` message, pull-to-refresh, and every haptic *call site* other
than the one below) stays **planned** until the pieces that call them (§4 gesture finish, step 9
headers, step 14 shell polish) land.

- **Android hardware Back installs on every Android form factor.**
  `shouldInstallNativeBackHandler` (`mobile/src/lib/native-phone-navigation.ts`)
  is just `isAndroid` now — it used to also require the iOS-only
  `allowsBackForwardNavigationGestures` WebView prop to read `false`, and that
  prop happens to read `true` past the tablet breakpoint on Android too (where
  it has no effect), so an Android tablet had no in-app Back at all: the key
  backgrounded the app from any depth. Consumption is unchanged
  (`shouldConsumeNativeBack(hasBackDepth)` off the latest `nessie:back-state`).
  Android's predictive back gesture is opted in alongside it
  (`android.predictiveBackGestureEnabled` in `mobile/app.json`, per plan §7):
  React Native 0.81+ (the installed `react-native` is 0.83) moved `BackHandler`
  onto the invoked-callback-compatible path so the plain `hardwareBackPress`
  listener keeps firing with the flag on; the system's predictive-back preview
  only ever shows the launcher, never an in-app screen, and the in-app motion
  stays the web stack's.
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

## 7. Everything else — **planned**

Nested stages, overlay kinds and layers, screen headers, prewarm and
skeletons, drafts (auto-save, no confirm dialogs), focus and announcements,
scroll, keyboard, haptics, pull-to-refresh, cold-start seeding, gates and the
transition test suite: all specified in the plan and added here as each
lands.
