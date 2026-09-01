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

## 4. Registry, controller, Back — **planned** (steps 3–4)

`admin/src/navigation/surfaces.ts` classifies every route; the controller
owns one ledger, one `navigate` wrapper (`push`, `replace`, `back`,
`redirect`, `openFlow`) and one Back registry; `resolveBack()` is the only
function that decides what Back does, for the header button, the edge swipe,
Android hardware Back, Escape and browser POP alike.

Today: `admin/src/layouts/admin-shell/phone-navigation.ts` classifies the
phone routes, `PhoneNavigationProvider` owns the phone ledger, and
`PhoneNavigationButton` → `performBack` is the shared phone doorway. Use
those; do not add a route family without a row there.

## 5. Everything else — **planned**

Layout by `ShellEnvironment.navigation`, nested stages, overlay kinds and
layers, screen headers, prewarm and skeletons, drafts (auto-save, no confirm
dialogs), focus and announcements, scroll, keyboard, haptics, pull-to-refresh,
cold-start seeding, gates and the transition test suite: all specified in the
plan and added here as each lands.

## 6. Native shell contract

The two `mobile/` ↔ admin bridge facts the plan (§4.7, §4.15, §4.16, §7)
calls out as their own pieces are **built**; the rest of §4.15/§4.16 (the
`nessie:screen` message, pull-to-refresh, and every haptic *call site* other
than the one below) stays **planned** until the navigation controller (§4)
lands and has something to call them from.

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
  `App.tsx`. Its one caller today is `IncomingCallProvider`'s ring
  (`warning` on native — a one-shot notification, not a repeating buzz — the
  browser path keeps its own repeating `navigator.vibrate` pattern via the
  same helper's fallback); the swipe-commit/sheet-snap/tab-change triggers
  §4.15 describes are added once the controller exists to call them from.
