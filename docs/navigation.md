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

- **A committed swipe gives one `light` haptic** (`lib/haptics.ts`, §8) at
  the moment the settle lands and the route is about to change. A cancelled
  swipe and a tapped Back give none.

Planned in this step: `BackButton` as the single glyph in every header on
every layout.

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

## 6. Nested stages — **built** (step 6, the core; the adopters follow)

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

Adopters (this step, in progress): `ColumnBrowserViewport` on `single`
mounts each column beyond the first as a stage; Knowledge's folder /
document / history / editor become stages and `animate-kb-view-slide` is
deleted; the executor and dashboard side panels become stages on `single`;
`AgentDetailPage` drops its own Back registration now that `/agents/:id` is
a real depth-2 route.

## 7. Overlays — **built** (step 8, the layer scale and the hook; the primitives follow)

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
`useOverlayDismiss` are its internals; nothing may compose them on its own
(the fourteen files that still do adopt a primitive in this step).

**`Dialog`** (`components/shared/Dialog.tsx`) is the Modal primitive on this
hook, unchanged in API plus `blocking` for the sanctioned nesting;
`ConfirmDialog` builds on it. Planned in this step: `Sheet` for the eight
drawers, `Popover` with one `placePopover` helper, `Card` with one
`CardViewport`, `presentation: 'panel' | 'full'` for Flows, and the adoption
of every bespoke overlay. Pinned by `admin/test/navigation-overlay.test.ts`
and `admin/test/dialog-shell.test.ts`.

## 8. Native shell contract — **built** (the two bridge pieces)

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

## 9. Verification — the transition suite — **built** (step 2)

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

## 10. Everything else — **planned**

Nested stages, overlay kinds and layers, screen headers, prewarm and
skeletons, drafts (auto-save, no confirm dialogs), focus and announcements,
scroll, keyboard, haptics, pull-to-refresh, cold-start seeding, and the
transition test suite: all specified in the plan and added here as each
lands.
