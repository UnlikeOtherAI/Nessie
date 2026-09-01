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

## 3. Motion — **planned** (step 2)

One spec: `--nav-duration` 300 ms, `--nav-easing`
`cubic-bezier(0.22, 1, 0.36, 1)`, `--nav-parallax` 0.28, one edge shadow;
overlay, popover, drawer and card durations as tokens; one
`runStackTransition()` on the Web Animations API drives pushes, pops and the
edge-swipe settle. Reduced motion is 0 ms through the same path.

Today: the phone route push is a CSS keyframe (300 ms) and the swipe settle a
separate Web Animation (220 ms) on the same curve.

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
