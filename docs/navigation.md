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
its motion and its Back rule. **Planned** (step 3 makes the registry total).

| type | what it is | motion | Back |
| --- | --- | --- | --- |
| Root | a section's home (Channels, Projects, Knowledge, Admin, Search) | none | none; shows the menu |
| Detail | a screen with one parent | push / pop | to its parent |
| Nested detail | a push from a Detail (info → members → add; folder → document) | push / pop | to the previous stage |
| Tab host | a Detail whose sections swap in place | none (pill only) | leaves the host |
| Flow | a full-screen form or wizard; a screen on phones, a panel on split layouts | push / pop or open / close | closes the flow |
| Overlay | modal, sheet, popover, card | open / close | closes the overlay only |

A sibling swap (channel A → B) is a Detail whose identity key is unchanged and
never animates. A tab is never a history entry.

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

## 4. Controller and Back — **built** (step 4, wiring in progress)

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

Planned in this step: `BackButton` as the single glyph in every header on
every layout; a haptic on the swipe commit (with the mobile shell's haptics
bridge).

Route classification still lives in
`admin/src/layouts/admin-shell/phone-navigation.ts` until the registry
(step 3) lands.

## 5. Everything else — **planned**

Layout by `ShellEnvironment.navigation`, nested stages, overlay kinds and
layers, screen headers, prewarm and skeletons, drafts (auto-save, no confirm
dialogs), focus and announcements, scroll, keyboard, haptics, pull-to-refresh,
cold-start seeding, gates and the transition test suite: all specified in the
plan and added here as each lands.
