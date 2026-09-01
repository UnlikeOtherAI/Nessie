# One navigation motion system — review and proposal

**Status:** review + proposal, 2026-09-01. Nothing here is built yet.
**Trigger:** on the iPhone shell, tapping a channel slides the conversation in,
overshoots to the left (the avatars touch the screen edge, the Back chevron is
clipped), then springs back to rest.

## 1. The bounce — root cause

The push itself cannot overshoot: `.phone-navigation-screen` animates
`translate3d(100%) → 0` with `cubic-bezier(0.22, 1, 0.36, 1)`, whose control
points never leave the 0–1 range (`admin/src/styles.css`, "Phone list/detail
navigation"). The overshoot is not the animation. It is a **stale horizontal
scroll offset on the `overflow: hidden` viewport** that the compositor keeps
applying after the transform has reached zero.

Sequence, all in `PhoneNavigationViewport.tsx`:

1. A forward push mounts the destination in the `--forward-ready` pose,
   `translate3d(100%, 0, 0)`, so the browser paints its DOM once before motion
   starts. During that commit the destination's descendants run their layout
   effects.
2. `components/primitives/TabBar.tsx` runs
   `scrollIntoView({ block: 'nearest', inline: 'nearest' })` on its selected
   item in a `useLayoutEffect` (keeps a clipped tab label visible on narrow
   strips). The channel screen contains the Messages / Files / Automations /
   Agents `TabBar`, so this fires while the screen sits one viewport-width to
   the right.
3. `scrollIntoView` scrolls **every** scrollable ancestor. `overflow: hidden`
   boxes are scroll containers — they hide the bars but accept programmatic
   scrolling — and a transformed child extends its parent's scrollable
   overflow. The `.phone-navigation-viewport` therefore acquires a positive
   `scrollLeft` (114 px in the Chromium reproduction below).
4. The transform animation runs on the compositor. The main thread only
   re-clamps `scrollLeft` to the current scrollable extent when something
   forces layout — a React commit for the loading feed, `useStickToBottom`'s
   ResizeObserver, a query resolving. Each clamp leaves whatever residue the
   transform still had at that moment (33 px at 40 % of the animation, 7 px at
   60 % in the reproduction).
5. The compositor then carries the transform to 0 while that residue is still
   subtracted, so the screen lands **left of rest by the residue**. The next
   layout (`finishTransition` swapping the class to `--current`) clamps
   `scrollLeft` to 0 and the screen snaps back. That is the "went in a bit
   further, then bounced back" the screenshot captured; a ~8 pt residue
   matches how far the avatars and chevron were shifted.

Reproduction (`2026-09-01-navigation-motion-system/repro.html` + `repro.mjs`, Playwright, Chromium 1194, 393 px viewport, the
viewport CSS copied verbatim, 3 s animation so a layout flush can be placed):

| scenario | `scrollLeft` after mount | `scrollLeft` after a mid-animation layout flush |
| --- | --- | --- |
| `overflow: hidden` + TabBar `scrollIntoView` | 114 px | 33 px at 40 %, 7 px at 60 % |
| `overflow: hidden`, no `scrollIntoView` | 0 | 0 |
| `overflow: clip` + TabBar `scrollIntoView` | 0 | 0 |

Headless screenshots flush layout before capture, so the residue is not visible
in a still — the offset itself and its clamping are what the table proves; the
device capture is the visual half.

The same defect class exists wherever a screen slides inside a hidden-overflow
box: `ColumnBrowserViewport` (Workflows / Tools / Integrations / Triggers on a
phone) wraps its sliding track in `overflow-hidden`, and its columns mount
`TabBar`s too. Any `autoFocus` or `.focus()` without `preventScroll` on a
mounting screen triggers it as well (`ConversationInfoFlow`,
`ChannelSearchPanel`, TipTap focus in `useChannelComposer`).

**Fix (structural, one place):** the stack containers become `overflow: clip`
— `.phone-navigation-viewport`, `.phone-navigation-screen`, `main`'s
`overflow-hidden`, and the `ColumnBrowserViewport` wrapper — with
`overflow-x: clip` on `.phone-navigation-page`. A `clip` box is *not* a scroll
container, so no descendant can scroll it, whatever it calls; policing every
`scrollIntoView`/`focus` call site would be the patch-on-patch. `overflow:
clip` is supported from Safari / iOS 16, Chrome 90, Firefox 81 (MDN
browser-compat-data); the mobile app's deployment target is iOS 16.0
(`mobile/app.json`), so nothing is left behind. `TabBar` additionally guards
its own scroll — it should scroll the strip only (`trackRef.scrollLeft`), never
call `scrollIntoView`, because "keep the label visible" is a fact about the
strip, not about every ancestor.

## 2. What exists today — five motion vocabularies

| # | Mechanism | Where | Motion | Direction source | Gesture | Reduced motion |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | Phone route stack: `PhoneNavigationViewport` + `phone-navigation.ts` matrix + ledger + provider + `use-phone-back-swipe` + native bridge | phone layout only, routes the matrix classifies | CSS keyframes 300 ms `cubic-bezier(0.22,1,0.36,1)`, 28 % parallax, edge shadow | route depth in the matrix | edge swipe, settle via WAAPI **220 ms** | yes |
| 2 | `ColumnBrowserViewport` track | Workflows, Tools, Integrations, Triggers (phone = one column per screen, tablet 2, desktop 3) | Tailwind `transition-transform duration-300 ease-out` translateX | column index | none | no |
| 3 | `animate-kb-view-slide` | Knowledge columns and filesystem browser | 220 ms `ease-out`, 18 px slide + fade | none (every render of the view) | none | no |
| 4 | Drawers: `MobileNavDrawer` (200 ms), `AttachmentsDrawer` (300 ms), agent/user info drawers | modal surfaces | Tailwind `transition-transform` | open flag | none | no |
| 5 | No motion at all | tablet/desktop detail column (channel → info → members, apps → app, dashboards → dashboard), thread reply panel on tablet, `Dialog`, and every phone route the matrix does not classify | instant swap | — | — | — |

Where the phone stack does **not** apply: `getPhoneNavigationScreen` returns
`null` for `/threads`, `/work`, `/chats`, `/feedback`, `/alerts` and
`/integrations` (while its sibling `/unread-messages` is a depth-1 Channels
screen); every admin-prefixed
route collapses to one `admin:detail` screen at depth 1, so Agents → agent
detail, Settings → Members, `/agents/designer` all swap with no motion; and when
the viewport unmounts for an unclassified route the retained lower screens
(scroll position, component state) are lost. On tablet and desktop nothing
animates, so the same tap on an iPad gives a hard cut where the phone gives a
slide.

The two implementations of the *same* push in #1 already disagree: the route
push is a 300 ms CSS keyframe, the gesture settle is a 220 ms Web Animation. The
motion tokens in `styles.css` (`--duration-fast: 120ms`, `--duration-base:
200ms`, `--easing-standard: ease`) are used by none of the five.

## 3. Proposal — one stack, one motion spec, every surface

Rule zero applies to motion the way it applies to controls (`TabBar`,
`Dialog`): the admin gets **one** navigation transition, parameterised by where
it is mounted, and no second implementation of a push.

### 3.1 One motion spec

`admin/src/lib/navigation-motion.ts` exports the numbers, and `styles.css`
exposes them as tokens (`--nav-duration`, `--nav-easing`, `--nav-parallax`,
`--nav-shadow`) so CSS and JS read one source:

- duration 300 ms, easing `cubic-bezier(0.22, 1, 0.36, 1)` (the current route
  curve — decelerating, no overshoot by construction), parallax 0.28, one edge
  shadow;
- gesture settle uses the **same** duration and curve, scaled by the remaining
  travel, so a released swipe and a tapped Back feel identical;
- `prefers-reduced-motion` → duration 0 through the same code path (never a
  second branch that skips steps).

### 3.2 One stack component

`PhoneNavigationViewport` becomes `NavigationStack`, mounted wherever a
list/detail stack lives:

- **Phone:** the whole content region, as today.
- **Tablet and desktop:** the *detail column* (`main`). Sibling selection from
  the pinned list (channel A → channel B, space A → space B) stays an instant
  swap — same-depth, same layer key, exactly what the matrix already encodes —
  while going deeper (channel → info → members, apps → app, dashboards →
  dashboard, agent list → agent) pushes inside the column, matching iPadOS
  split views. The iPad keeps its native back/forward swipe off in the detail
  column for the same reason phones do (`webview-back-gesture.ts`).
- **Column browsers:** `ColumnBrowserViewport` on a phone renders its columns
  as `NavigationStack` layers instead of its own translateX track; on tablet
  and desktop it keeps the multi-column track but drives it with the same
  tokens. Its `LocalBack` registration stays the Back owner; only the motion
  is shared.
- **Knowledge:** folder-in on a phone is a push; the fade-slide
  (`animate-kb-view-slide`) is removed rather than kept as a third vocabulary.

Motion is driven by **one function** — `runStackTransition(top, bottom,
direction, from)` on WAAPI — used by route pushes, Backs, and gesture settles.
The CSS keyframes go, so the route push and the settle can no longer drift
(today's 300 ms vs 220 ms). A layer's rest and prepared poses remain CSS
classes; only the travel is scripted, from exactly the current inline
transform, which is what the settle already does.

### 3.3 One classifier, no fallthrough

`phone-navigation.ts`'s matrix is already the right shape (section, depth,
identity, key scope, Back target) and is shared by the tab bar, hardware Back,
the swipe and the native bridge. It grows to cover every authenticated route
so `getPhoneNavigationScreen` never returns `null`: `/threads`, `/work`,
`/chats`, `/feedback`, `/alerts`, `/integrations`, and the admin family split
into real depths (`/agents` 1 → `/agents/:id` 2 → designer 2, `/settings` 0 →
`/settings/*` 1, `/ops` 1 → `/ops/usage` 2). The `admin:detail` catch-all is
deleted. The direction rule stays depth-only; cross-section moves (tab taps)
stay instant, as native tab bars are.

### 3.4 Containers cannot be scrolled by their content

Every stack container is `overflow: clip` (§1). `TabBar` scrolls only its own
track. `autoFocus` inside a screen that can be pushed uses
`focus({ preventScroll: true })` after the transition settles, via a
`useStackSettled()` hook the stack exposes — the same hook the composer needs
so the keyboard does not rise mid-slide.

### 3.5 Modal surfaces read the tokens but stay out of the stack

Drawers, sheets and `Dialog` are not navigation; they keep their own open/close
but use `--nav-duration`/`--nav-easing` so the app has one motion voice. The
thread reply panel is a stack push below 900 px (already routed that way) and a
token-driven side-panel slide above it.

### 3.6 Native shell

Unchanged in principle: the web owns motion, the shell owns chrome. The only
work is confirming the iPad keeps `allowsBackForwardNavigationGestures` off
once the detail column pushes, and that `nessie:back-state` reports depth from
the extended classifier.

## 4. Order of work

1. `overflow: clip` on the four containers + `TabBar` track-only scroll. This
   alone removes the bounce on every current phone push. Verify on device and
   with the reproduction script.
2. Motion tokens + `runStackTransition`; route push and gesture settle share it;
   delete the keyframes. Existing tests
   (`admin/test/phone-navigation-transition.test.ts`,
   `phone-back-swipe-viewport.test.ts`, `phone-navigation-stack.test.ts`) keep
   passing; add one asserting the settle and the push read the same duration.
3. Classifier coverage for every route; delete `admin:detail`.
4. Mount `NavigationStack` in the tablet/desktop detail column; fold
   `ColumnBrowserViewport` (phone) and the Knowledge slide into it.
5. Drawers/dialogs on the tokens; `useStackSettled` for autofocus.

Each step is independently shippable and verified with headless Playwright at
phone, tablet and desktop widths per `AGENTS.md` → "Verification".
