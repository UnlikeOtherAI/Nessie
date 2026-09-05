# iOS native navigation bar

Status: plan, awaiting review.

Scope: the **iOS native shell only** (`mobile/` running on iPhone). Mobile
Safari, the Android app, iPad and desktop keep exactly today's behaviour, pixel
for pixel. Every change below is gated on one existing probe —
`useNativeIOSPhoneApp()` on the web side, `platform === 'ios'` on the native
side — and no shared code path changes its answer off that gate.

## 1. The defect

On an iPhone, swiping back out of a conversation makes the page jump downwards
at the moment the gesture commits, and the native bar appears a whole animation
late. Mid-swipe, the revealed root sits under the status bar with no bar at all.

It is one geometry bug, in
[`mobile/src/lib/native-shell-layout.ts`](../../mobile/src/lib/native-shell-layout.ts):

```ts
shouldShowNativePhoneHeader = showBar && !isIpad && (largePhoneLandscape || isTabRoot)

getNativeWebviewFrameInsets(...).top =
  safeArea.top + (showNativePhoneHeader ? nativePhoneHeaderHeight : 0)
```

So the WebView's own frame is a function of *which kind of screen the admin
says it is on*:

| screen | native bar | WebView frame top | who draws the header |
| --- | --- | --- | --- |
| tab root (`/channels`) | shown | `safeTop + 64` | native (`NativePhoneHeader`) |
| detail (`/channels/:id`) | hidden | `safeTop` | web (`ScreenHeader`) |

Two consequences, both visible in the reported screenshots:

1. **The frame resizes on navigation.** Root ⇄ detail moves the WebView's top
   edge by 64pt, so the document relays out and the content shifts.
2. **It resizes at the wrong moment.** `isTabRoot` comes from the settled
   `nessie:screen` message, which the admin posts only *after*
   `runStackTransition` finishes. During the whole swipe the shell still
   believes it is on a detail, so the root being revealed is laid out under the
   status bar with no header; when the commit lands, the bar appears and the
   content drops 64pt in a single frame.

The web transition itself is correct and stays. What is wrong is that the
native chrome band is not a constant.

## 2. Outcome

On the iOS phone shell there is **one persistent native navigation bar** of
fixed height on every screen the tab bar is shown for. The WebView's frame
never changes with navigation, so nothing can jump. The bar carries a native
back button, the screen's title, and the screen's own actions; the web stops
drawing a header bar of its own there. The bar's contents animate in step with
the stack — including interactively, under the finger, during an edge swipe.

The admin keeps owning navigation: routes, the stack, the Back resolver, the
edge swipe, motion. Only the *chrome* moves to native.

## 3. What we are deliberately not doing

**Not a `UINavigationController`.** The obvious reading of "native navigation
bar" is `react-native-screens`' native stack, which would give us the system
bar for free — large titles that collapse on scroll, the back button's
long-press history menu, the system interactive pop. It is the wrong shape
here, for reasons the rulebook already records:

- The whole admin is **one WebView**. A native stack needs a native view per
  screen; ours would be N transparent placeholders over a single web document,
  with the real content never actually moving between them.
- The native stack owns the edge gesture. Two owners of one edge gesture is
  the exact failure `docs/navigation/native-shell.md` §10 documents and
  `NATIVE_BACK_FORWARD_GESTURES = false` exists to prevent. The admin's stack
  would have to give up its swipe — and with it the retained-layer motion,
  the dim, the settle, the nested stages and the haptic — to a controller that
  has no idea what is under the top layer.
- The registry, the ledger and `resolveBack()` are the single source of Back
  (§4). A native stack introduces a second one.

So: a native **bar**, not a native **stack**. What that costs, and how to buy
it back later, is §10.

## 4. The invariant

> On the iOS phone shell, the native chrome band above the WebView has a
> **constant height for the whole lifetime of a session past the auth gate**.
> No screen type, no transition state and no message from the web may change
> it.

Every rule below serves that one sentence. A future bar variant whose height
depends on the screen — a large title, a search field that appears on some
roots, a taller bar for a Flow — reintroduces this exact defect and is
forbidden without also moving the resize into the transition itself.

Heights, unchanged from today so the root's appearance does not move:

- portrait: `NATIVE_PHONE_MENU_HEADER_HEIGHT` (64) + `safeArea.top`
- the admitted large-phone landscape lane:
  `NATIVE_PHONE_LANDSCAPE_HEADER_HEIGHT` (46) + `safeArea.top`

## 5. The bar

Three lanes, one fixed-height row. Which lanes are filled is decided by the
screen's own `screenType`, which the admin already publishes.

**At a tab root** — byte-for-byte today's `NativePhoneHeader` portrait layout,
so the screen in the first screenshot does not change:

- leading: team avatar + team name + chevron (`onTeamPress`)
- title: empty (the team name is the title)
- trailing: focus-mode toggle, account avatar

**On a detail, nested stage, tab host or flow** — new:

- leading: back chevron + the parent's label (`resolveBack()`'s `label`),
  truncating to the chevron alone when the title needs the room
- title: the screen's published title, centred, single line, truncated
- trailing: the screen's actions (§7)

The bar keeps the surface, text and focus-mode palette it already reads from
`nessie:theme` / `nessie:focus`, and keeps travelling on the focus-mode curve
via `useNativeFocusChrome` (`mobile/src/lib/chrome-transition.ts`). Nothing
about theming changes.

The floating creation menu (`NativePhoneConversationMenuChrome`'s compose FAB)
keeps its current rule — channels root only — and is untouched.

## 6. What the web stops drawing

`admin/src/components/shared/ScreenHeader.tsx` is the one header every screen
renders, so this is one change in one file, not 31.

On the iOS phone shell **and the `single` layout only**, `ScreenHeader`:

- renders **no visible bar**: no leading lane, no visible `h1`, no actions row;
- still renders the `h1` as `sr-only`, with the same `titleId`, because the
  settle focuses it and the live region announces it
  (`docs/navigation/verification-and-settle.md` §12) — losing that would be a
  silent accessibility regression, and `admin/test/a11y-navigation.test.ts`
  and `navigation-settle.test.ts` must keep passing untouched;
- still calls `publishScreenTitle` / `retireScreenTitle` exactly as now — that
  registry is what feeds `nessie:screen` and `document.title`;
- still renders the `below` slot (`subtitle`, `tabs`) as the first row of the
  page, so a tab host's `TabBar` keeps its place directly under the bar.

Everywhere else — mobile Safari at any width, the Android app, iPad,
large-phone landscape's `split` layout, desktop — the component takes today's
path unchanged.

Two call sites need more than that:

- **`WorkflowDesignerHeader`** is the only `titleInput` user. A text field
  cannot live in the native bar; on the iOS phone shell it renders the input as
  the first row of the page body instead, with the native bar showing the
  designer's Back and a static title.
- **`singleLayoutOnly` headers** (Knowledge) already return `null` off
  `single`; on the iOS phone shell they still publish and still get a native
  bar, which is what they want.

## 7. The actions bridge

Header actions are not decoration — Rule zero says a capability nobody can
reach is unfinished — so hiding the web header without moving its actions is
not an option. 15 of the 31 `ScreenHeader` call sites pass `actions`.

`ScreenHeader` gains one publisher beside `publishScreenTitle`:
`publishScreenActions(pathname, actions)`, keyed by pathname for the same
reason titles are (retained and seeded layers are mounted at once). The bridge
posts the live screen's actions:

```
nessie:screen-actions {
  path: string,
  actions: Array<{
    id: string,
    label: string,
    icon: string | null,        // FontAwesome iconName, mapped natively
    disabled: boolean,
    primary: boolean,
    priority: number,
    tone: 'danger' | null,
    kind: 'button' | 'link' | 'menu' | 'switch',
    checked: boolean | null,    // switch
    items: Array<{ id, label, icon, disabled, checked }> | null,  // menu
  }>,
}
```

Native rendering, in `NativePhoneNavBar`:

- the highest-priority one or two actions with a **mapped** icon render as bar
  buttons;
- everything else — unmapped icons, links, menus, switches, low priority —
  goes into a trailing `⋯` that opens a native action sheet listing them by
  label, with menu items as a nested group and switches showing a checkmark.
  Nothing is ever dropped.
- Icon mapping is a small explicit table from FontAwesome `iconName` to the
  `MaterialIcons` set the mobile chrome already uses. An unmapped name is not a
  bug, it is the overflow path; a test pins that every icon the admin actually
  ships either maps or is reachable in the sheet.

A tap posts `nessie:screen-action { id, itemId? }` back; the admin resolves it
against the live screen's published actions and calls the original `onSelect`,
follows the `href`, or toggles the switch. Authorization, menus and confirmation
dialogs stay entirely in the web, exactly as `NativePhoneCreationBridge` and
`NativeIPadToolbarBridge` already do for their controls.

## 8. Motion

The bar must move with the stack, or it is a native bar bolted onto a web
transition and will read as broken in a different way.

Three additions to the bridge, all posted only when
`isReactNativeWebView() && iOS phone`:

1. **`nessie:screen-transition { from, to, direction, durationMs }`** — posted
   by `PhoneNavigationViewport` at the moment `runStackTransition` starts, for
   route pushes and pops and for nested-stage pushes and pops. `from`/`to` are
   bar descriptors `{ title, backLabel, hasBack, screenType }`. `to.title` is
   the incoming layer's already-published title when it has one, else — for a
   pop, which is the case that matters — `resolveBack()`'s label, which is
   always known. The settled `nessie:screen` remains authoritative and
   corrects any guess a frame later.
2. **`nessie:screen-swipe { progress }`** — posted from
   `use-phone-back-swipe.ts` while a drag is *claimed*, throttled to one
   message per animation frame. It carries the same 0..1 the layer transforms
   use.
3. On release the existing settle already calls `runStackTransition`, so it
   emits a `screen-transition` with the settle's remaining duration; a cancel
   emits one back to `from`.

Natively, `NativePhoneNavBar` renders two content layers — outgoing and
incoming — and drives their `opacity` and `translateX` with `Animated`
(`useNativeDriver: true`), mirroring UIKit: the title slides a short distance
and crossfades, the back chevron and its label fade. The curve is
`NAV_MOTION`'s `cubic-bezier(0.22, 1, 0.36, 1)` at 300ms;
`mobile/src/lib/chrome-transition.ts` already solves a cubic-bezier by
Newton-Raphson for the focus-mode curve and is generalized to take control
points rather than hard-coding `ease`. Reduced motion (already published by the
web) runs the same path at zero duration.

If a `screen-swipe` stream stops without a terminal `screen-transition` — a
killed WebView, a dropped message — the next settled `nessie:screen` snaps the
bar to the truth. The bar never has a state the web has not told it about.

## 9. Full-screen routes and the auth gate

`/channels/new` (`isFullScreenTaskRoute`) today hides all chrome, which is a
second frame change of the same kind, entered and left through a real stack
transition. It joins the constant-inset regime: it keeps the bar, with a
leading **Cancel** and its own title, and the tab bar stays hidden as it is
now. The bar band is present, so the geometry is unchanged across the push.

The auth gate (`/login`, `/bootstrap`) keeps no chrome. It is only ever reached
by a full document load or a logout that replaces the whole app, never by a
stack transition, so the frame change there is invisible and is accepted
deliberately rather than by omission.

## 10. What we lose, and the way back

Compared with a real `UINavigationController` we do not get: large titles that
collapse on scroll, the back button's long-press history menu, the system's own
interactive pop physics, and a translucent bar with content scrolling under it.

The first three are out of reach while the content is one WebView, and none is
load-bearing. The fourth is reachable later without touching this design: make
the bar translucent, stop insetting the WebView, and have the injected CSS give
the document a top padding equal to the bar — but that changes the geometry
contract and the scroll clearance rules, so it is a separate change, not a
rider on this one.

## 11. Implementation slices

Each slice leaves the app coherent and shippable on its own.

1. **Geometry.** `shouldShowNativePhoneHeader` splits into an iOS-persistent
   lane and today's answer for Android; `getNativeWebviewFrameInsets` becomes
   constant on iOS phone. The bar still renders only its root content, so a
   detail briefly gets an empty bar above its own web header — ugly for one
   slice, but **the jump is gone** and it is measurable in the simulator.
2. **Bar contents.** `nessie:screen` gains `backLabel`; the native bar renders
   back + title on non-root screens; `ScreenHeader` stops drawing its bar on
   the iOS phone shell and keeps the `sr-only` `h1` and the `below` slot.
3. **Actions.** `publishScreenActions`, `nessie:screen-actions`,
   `nessie:screen-action`, the native trailing buttons and the overflow sheet,
   the icon table.
4. **Motion.** `nessie:screen-transition`, `nessie:screen-swipe`, the two-layer
   animated bar, the generalized bezier.
5. **Edges.** `/channels/new`, `WorkflowDesignerHeader`'s title input, the
   landscape lane, focus-mode palette, and the sweep of all 31 `ScreenHeader`
   call sites for pages that drew extra chrome of their own.

## 12. Tests and docs

New or changed:

- `mobile/src/lib/native-shell-layout.test.ts` — the constant-band invariant
  stated as a test: for every `screenType`, the iOS phone frame inset is the
  same number, and the Android answers are unchanged.
- `mobile/src/components/native-nav-bar.test.ts` (new) — lane composition per
  screen type; the action partition (bar buttons vs overflow) including the
  "nothing is dropped" property.
- `mobile/src/lib/native-shell-message.test.ts` — guards for the three new
  messages, including rejecting malformed action payloads.
- `admin/test/screen-header.test.ts` — the iOS-phone branch renders no visible
  bar, still publishes its title, still renders one `h1`, still renders the
  `below` slot; and the non-iOS branches are untouched.
- `admin/test/native-touch-navigation.test.ts` — the transition and swipe
  messages are posted at the right moments and only on the iOS phone shell.
- `admin/e2e/navigation/cases/phone-back.mjs`, `phone-edge-swipe.mjs` — must
  stay green unchanged; they pin the web stack, which this does not alter.

Docs: `docs/navigation/native-shell.md` §10 gains the three messages and the
constant-band invariant; `docs/navigation/deep-links-and-headers.md` §9 gains
the iOS-phone rendering of `ScreenHeader`. Both change in the same turn as the
code, per the standards-routing rule.

## 13. Verification

- **Mobile Safari is unchanged**: Playwright at `http://localhost:5455` in a
  phone viewport, screenshot of a root and a detail, compared against `main`.
  This is the acceptance test for the "iOS only" constraint.
- **The native shell**: iOS Simulator. Attach the live panel, build, then
  screenshot a tab root and a conversation and confirm the bar band is the same
  height in both. Drive a partial back-swipe with a touch path, screenshot
  mid-gesture, and confirm the revealed root's first row sits at the same y as
  it does after the commit — that is the defect, stated as a measurement.
- Root, detail, nested stage (a Knowledge document), a tab host (a
  conversation's Files tab), a Flow (`/channels/new`), focus mode on and off,
  and the large-phone landscape lane.
