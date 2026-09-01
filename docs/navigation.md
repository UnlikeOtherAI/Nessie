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

## 5. Verification — the transition suite — **built** (step 2)

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
| `tablet-select` | 768×1024 | selecting a channel mounts no phone stack and slides nothing; the columns keep their geometry |
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

**Currently red: `phone-back`.** The route pop paints only the returning
list. `advancePhoneNavigationStack`'s same-depth branch truncates every entry
above `currentIndex`, and after a Back the outgoing screen *is* the entry
above `currentIndex` — so the first re-render that arrives on the same
pathname (the destination's own data settling is enough) drops it while the
transition is still running. `runStackTransition` then gets `top: null` and
animates the lower layer alone. The stack unit test
(`admin/test/phone-navigation-stack.test.ts`, "Back targets the retained
layer … and keeps outgoing DOM") passes because it advances the stack once
and never replays the same route; the browser suite is what sees it. Fix the
stack, not the suite.

## 6. Everything else — **planned**

Layout by `ShellEnvironment.navigation`, nested stages, overlay kinds and
layers, screen headers, prewarm and skeletons, drafts (auto-save, no confirm
dialogs), focus and announcements, scroll, keyboard, haptics, pull-to-refresh,
cold-start seeding, gates and the transition test suite: all specified in the
plan and added here as each lands.
