# iOS native navigation bar

Status: plan, revised after review (Fable, 2026-09-05: GO WITH CHANGES). Every
blocking finding is folded in below; §14 records what changed and why.

Scope: the **iOS native shell only** (`mobile/` running on iPhone). Mobile
Safari, the Android app, iPad and desktop keep exactly today's behaviour, pixel
for pixel. Every change is gated on one existing probe —
`useNativeIOSPhoneApp()` on the web side, `platform === 'ios'` on the native
side — and no shared code path changes its answer off that gate.

## 1. The defect

On an iPhone, swiping back out of a conversation makes the page jump downwards
when the gesture commits, and the native bar appears a whole animation late.
Mid-swipe the revealed root sits under the status bar with no bar at all.

It is one geometry bug, in
[`mobile/src/lib/native-shell-layout.ts`](../../mobile/src/lib/native-shell-layout.ts):

```ts
shouldShowNativePhoneHeader = showBar && !isIpad && (largePhoneLandscape || isTabRoot)

getNativeWebviewFrameInsets(...).top =
  safeArea.top + (showNativePhoneHeader ? nativePhoneHeaderHeight : 0)
```

The WebView's own frame is a function of *which kind of screen the admin says
it is on*:

| screen | native bar | WebView frame top | who draws the header |
| --- | --- | --- | --- |
| tab root (`/channels`) | shown | `safeTop + 64` | native (`NativePhoneHeader`) |
| detail (`/channels/:id`) | hidden | `safeTop` | web (`ScreenHeader`) |

So root ⇄ detail moves the WebView's top edge by 64pt and the document relays
out. **When** that happens differs by how you navigated, and both are wrong:

- **A tapped push or pop resizes at the start.** `nessie:screen` is posted from
  a passive effect in `NativePhoneNavigationBridge.tsx` on route commit, which
  runs *before* `runStackTransition` has moved anything. The band changes
  height, then the layers animate.
- **A swipe resizes at the end.** The swipe commits only when the settle
  animation finishes (`use-phone-back-swipe.ts` `closeSettle('commit')` →
  `onCommit` → `navigate`), so for the whole gesture the shell still believes
  it is on a detail. The revealed root is laid out under the status bar; at the
  commit the bar appears and the content drops 64pt in one frame.

That second case is the reported bug. The first is the same defect wearing a
different hat, and the fix below removes both.

The web transition itself is correct and stays. What is wrong is that the
native chrome band is not a constant.

## 2. Outcome

On the iOS phone shell there is **one persistent native navigation bar** of
fixed height on every screen the tab bar is shown for. The WebView's frame
never changes with navigation, so nothing can jump. The bar carries a native
back button, the screen's title, and the screen's own actions; the web stops
drawing a header bar of its own there. The bar's contents animate in step with
the stack.

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
  with the real content never moving between them.
- The native stack owns the edge gesture. Two owners of one edge gesture is
  the exact failure `docs/navigation/native-shell.md` §10 documents and
  `NATIVE_BACK_FORWARD_GESTURES = false` exists to prevent. The admin's stack
  would have to give up its swipe — and with it the retained-layer motion, the
  dim, the settle, the nested stages and the haptic — to a controller that has
  no idea what is under the top layer.
- The registry, the ledger and `resolveBack()` are the single source of Back
  (§4). A native stack introduces a second one.

So: a native **bar**, not a native **stack**. What that costs, and the fallback
if the bar's sync proves visibly poor on device, is §10.

## 4. The invariant

> On the iOS phone shell, the native chrome band above the WebView has a
> **constant height for the whole lifetime of a session past the auth gate**.
> No screen type, no transition state and no message from the web may change
> it.

Every rule below serves that sentence. A future bar variant whose height
depends on the screen — a large title, a search field on some roots, a taller
bar for a Flow — reintroduces this exact defect and is forbidden without also
moving the resize into the transition itself.

Heights, unchanged from today so the root's appearance does not move:

- portrait: `NATIVE_PHONE_MENU_HEADER_HEIGHT` (64) + `safeArea.top`
- the admitted large-phone landscape lane:
  `NATIVE_PHONE_LANDSCAPE_HEADER_HEIGHT` (46) + `safeArea.top`

Rotation between the two is a `split`/`single` layout change, not a navigation
change, and it already re-lays out the whole shell. The landscape lane keeps
today's compact toolbar and today's web headers in the detail column; this plan
does not change it, and §4's constant is per-lane, not across a rotation.

## 5. What the bar shows, and where it learns it

### 5.1 Publication is per layer, not per pathname

This is the structural correction that makes everything else work.

`publishScreenTitle` is keyed by pathname and is last-writer-wins
(`admin/src/navigation/screen.ts`), and `screenType` is read from
`matchSurface(pathname)` in `describeScreen`. Both are wrong for the bar:

- **A nested stage never changes the pathname.** A Knowledge document editor
  open over `/knowledge-base` reports `screenType: 'root'`, so a bar keyed off
  `screenType` would show the team switcher while the reader is in an editor.
  The same holds for `dashboard:add-widget`, `executors:create` and every
  column-browser column. (Today's `App.tsx` has the same blind spot in
  `isTabRoot`, which is why a Knowledge stage keeps the team bar on iPhone
  right now.)
- **Two headers can share one pathname.** `/channels/:id/info` is a real route:
  `ChannelConversationSurface` mounts the channel's `ScreenHeader` *and*
  `ChannelsPage` mounts `ConversationInfoFlow`, which draws its own header. The
  channel's title is published under the info pathname, so the bar would read
  "#design" with the channel's call/search/settings actions while the screen
  says "Conversation info".

So the admin publishes a **bar descriptor per stack layer**, keyed by the
layer key the stack already stamps (`PhoneNavigationLayer`'s
`data-phone-navigation-route`; a stage's key is `stage:<id>`):

```ts
publishScreenBar(layerKey, {
  title: string,
  back: { label: string, owner: 'page' | 'route' } | null,
  actions: BarAction[],
})
```

`PhoneNavigationViewport` knows which entry is current and is what the bridge
reads. `NestedStage` gains a `title` prop and publishes under its own key, so a
stage finally names itself. `publishScreenTitle` stays exactly as it is for
`document.title` — that is a per-pathname fact and is not changing.

### 5.2 The lanes

Three lanes, one fixed-height row. Which lanes are filled is decided by
**whether the current layer published a `back`** — never by `screenType`.

**No back (a tab root)** — byte-for-byte today's `NativePhoneHeader` portrait
layout, so the first screenshot's screen does not change:

- leading: team avatar + team name + chevron (`onTeamPress`)
- title: empty (the team name is the title)
- trailing: focus-mode toggle, account avatar

**A back (detail, nested stage, tab host, flow):**

- leading: back chevron + the published `back.label`, truncating to the chevron
  alone when the title needs the room
- title: the layer's published title, centred, single line, truncated
- trailing: the layer's actions (§7)

**Before the first descriptor arrives** — a cold start, a push-notification
deep link — the bar is the surface colour and nothing else. It must not fall
back to root lanes, or a deep link flashes team chrome on the way to a
conversation. (`DEFAULT_LAST_KNOWN_SCREEN` is `root` with an empty title, so
this has to be explicit.)

The bar keeps the surface, text and focus-mode palette it already reads, and
keeps travelling on the focus-mode curve via `useNativeFocusChrome`. The
floating creation menu keeps its current rule — channels root only — untouched.

### 5.3 Back is the header's answer, not the resolver's

The plan's first draft had the native chevron call `__nessieNativeBack` →
`performBack()`. That is wrong for every Flow that owns its Back:
`ScreenHeader` replaces the shared doorway with the page's own `onBack` when
`flowOwnsBack` is set, and those pages return to an address the registry cannot
know — compose's `returnTo`, the designer's edit origin, connected-mail
compose. A resolver-driven chevron would pop to `/channels` instead of the
project the compose was opened from.

So the descriptor publishes the **effective** Back — the one the header would
render — and the native tap invokes that published handler by layer key. The
resolver remains the source for everything else (`hasBack`, Android hardware
Back, the edge swipe); it is just no longer what the chevron calls.

## 6. What the web stops drawing

On the iOS phone shell **and the `single` layout only**, a screen header:

- renders **no visible bar**: no leading lane, no visible `h1`, no actions row;
- still renders the `h1` as `sr-only`, with the same `titleId`, because
  `settleFocus`/`announceScreen` (`admin/src/navigation/settle.ts`) find the
  screen by `querySelector('h1')` and read its `textContent` — `.sr-only`
  keeps both, so §12 survives, but losing the element would break it silently;
- still publishes `document.title` exactly as now;
- still renders the `below` slot (`subtitle`, `tabs`) as the first row of the
  page, so a tab host's `TabBar` keeps its place directly under the bar.

Everywhere else — mobile Safari at any width, the Android app, iPad, the
landscape `split` lane, desktop — the untouched path.

**This is not one file.** Four components draw a screen-level header outside
`ScreenHeader` today, and none of them publishes anything:

| component | what it draws | fix |
| --- | --- | --- |
| `ConversationInfoFlow` `FlowHeader` | 58px `<header>` + `<h1>` + `PhoneNavigationButton` | convert to `ScreenHeader` (trivial) |
| `KnowledgePane` | `ResponsivePageHeader` with `onBack` | publish per stage key (§5.1); Cancel/Save become bar actions |
| `WorkflowDesignerHeader` | `ResponsivePageHeader` with `titleInput` | see below |
| `ColumnBrowserColumn` | 50px row + `PhoneNavigationButton` + `h3` | publish per column stage key |

`WorkflowToolbar` also renders a `ResponsivePageHeader`, but as
`titleTone="section"` — a section header inside a page, not a screen header.
It is out of scope and stays.

`admin/test/screen-header.test.ts`'s source gate walks `admin/src/pages` only,
which is exactly how these four escaped. The gate widens to `admin/src` and
fails on any new `<header>` or `<h1>` outside the shared header.

**`titleInput`** (`WorkflowDesignerHeader`) has no native equivalent. On the
iOS phone shell the designer renders the input as the first row of the page
body, publishes a static title, and its Back and Save become bar entries.

## 7. The actions bridge

Header actions are not decoration — Rule zero says a capability nobody can
reach is unfinished — so hiding the web header without moving its actions is
not an option.

The descriptor's `actions` carry every field that changes behaviour or
appearance, because the first draft dropped four that do:

```
BarAction {
  id, label, disabled, primary, priority, tone,
  kind: 'button' | 'link' | 'menu' | 'toggle',
  submit: boolean,      // `submit: true` actions carry `onSelect: () => undefined`
                        // and work only by submitting their form — Notifications'
                        // "Save preferences", PageEditor's Save. Dropping this
                        // makes them dead native buttons.
  selected: boolean,    // recording-routine red, call-active, search-open
  checked: boolean | null,
  items: [...] | null,  // menu
}
```

- A **`submit`** tap posts back and the web calls `form.requestSubmit()` on the
  named form — not `onSelect`.
- **`selected`/`pressed`** render as a filled bar button, so a live call or an
  open search still reads as on.
- A **`link`** with `target: '_blank'` goes through the existing
  `nessie:open-external` path, never a native `href` follow.
- **`leading`** (agent avatar, app icon) and **`eyebrow`** ("System managed",
  the designer's save status) have no bar home and stay in the page's first
  row, beside the `below` slot. Stated deliberately rather than lost.

Native rendering is **text-first, as UIKit bars are**: the `primary` action
renders as a text button; everything else goes into a trailing `⋯` action
sheet listing actions by label, with a menu opening a second sheet. There is no
FontAwesome→MaterialIcons table and no icon-coverage test — an icon vocabulary
maintained across two repos is exactly the thing that rots, and the sheet is
both more native and lossless.

A tap posts `nessie:screen-action { layerKey, id, itemId? }`; the admin
resolves it against that layer's published actions. Authorization, menus and
confirmation dialogs stay entirely in the web, as `NativePhoneCreationBridge`
and `NativeIPadToolbarBridge` already do.

## 8. Motion

**Ordering first, animation second.** `nessie:screen` is posted from a passive
effect on route commit — *before* `runStackTransition` runs. If the bar snapped
to it and then animated, every tapped push would double-take.

So:

1. `nessie:screen-transition { from, to, direction, durationMs }` is posted
   from `PhoneNavigationViewport`'s `startTransition` — a layout effect, which
   runs before the bridge's passive effect — for route pushes and pops and for
   stage pushes and pops. `from`/`to` are the two layer keys; the bar already
   holds their descriptors.
2. The native bar treats a `nessie:screen` arriving **while a transition is in
   flight** as the transition's target, never as a reason to snap.
3. The post is gated on `layout === 'single'`, or the landscape `split`
   viewport would post its column pushes as if they were the bar's.

Natively, the bar renders two content layers — outgoing and incoming — and
drives `opacity` and `translateX` with `Animated` (`useNativeDriver: true`):
the title slides a short distance and crossfades, the chevron and its label
fade. Curve and duration are `NAV_MOTION`'s — `Easing.bezier(0.22, 1, 0.36, 1)`
at 300ms. **React Native already solves this bezier**; `chrome-transition.ts`'s
solver is the Android and iPad focus-mode curve and is not touched.

Reduced motion is read natively from `AccessibilityInfo.isReduceMotionEnabled()`
and its change event. The web does not publish it and never did.

**Interactive swipe tracking is deferred to a follow-up, deliberately.** Every
message goes through `App.tsx`'s `onMessage` → `handleNativeShellMessage` →
React state, so a per-frame stream would re-render `<Shell>` — the `WebView`
included — 60 times a second, and WKWebView→RN latency would leave the bar a
frame or two behind the layers anyway. Slice 4 ships release-time animation: on
release the settle already calls `runStackTransition`, so it emits a
`screen-transition` with the settle's remaining duration, and a cancelled swipe
emits one back to `from`. If the bar sitting still during the drag reads badly
on device, the follow-up adds `nessie:screen-swipe { progress }` **short-
circuited before the message handler** and written straight to an
`Animated.Value` ref, never through React state.

If a stream ever stops without a terminal `screen-transition`, the next settled
`nessie:screen` corrects the bar. The bar never holds a state the web has not
told it about.

## 9. Full-screen routes and the auth gate

`/channels/new` (`isFullScreenTaskRoute`) hides all chrome today, which is a
second frame change of the same kind, entered and left through a real stack
transition. On iOS it joins the constant-inset regime: it keeps the bar, with a
leading **Cancel** and its own title, and the tab bar stays hidden as now.
`showBar` and `isFullScreenTaskRoute` are shared with Android, so this branches
on `platform === 'ios'` and Android's answer is unchanged.

The auth gate (`/login`, `/bootstrap`) keeps no chrome. It is only ever reached
by a full document load or a logout that replaces the whole app, never by a
stack transition, so the frame change there is invisible and is accepted
deliberately rather than by omission.

## 10. What we lose, and the fallback

Compared with a real `UINavigationController` we do not get: large titles that
collapse on scroll, the back button's long-press history menu, the system's own
interactive pop physics, and a translucent bar with content scrolling under it.
The first three are out of reach while the content is one WebView. The fourth
is reachable later — make the bar translucent, stop insetting the WebView, give
the document a top padding equal to the bar — but that changes the geometry
contract and the scroll-clearance rules, so it is a separate change.

**The fallback, if bar/content sync reads badly on device:** keep the *band*
native and draw the bar *contents* in the web, inside each layer,
counter-animated from the same poses the layers already use. Zero bridge
traffic, perfect sync by construction, no action serialization at all, and the
`h1` stays visible. It costs the actual native controls the user asked for, so
it is the fallback and not the default — but it is cheap to reach from here,
because §4's constant band is what makes it work and that lands in slice 1.

## 11. Implementation slices

**The minimum shippable change is slices 1–3 together.** Slice 1 alone leaves a
blank band above every detail's web header; slice 2 alone hides a header whose
actions have nowhere to go, which Rule zero forbids. They are listed separately
because they are separately reviewable, not separately releasable.

1. **Geometry.** `shouldShowNativePhoneHeader` splits into an iOS-persistent
   lane and today's answer for Android; `getNativeWebviewFrameInsets` becomes
   constant on iOS phone. The band renders as **bare surface** on non-roots —
   not root lanes, which would put a team switcher and an account avatar above
   every conversation. The jump is gone and measurable at this point.
2. **Descriptors and bar contents.** `publishScreenBar` keyed by layer key;
   `NestedStage` gains `title`; the four stray headers convert; the source gate
   widens; the native bar renders back + title; the web stops drawing its bar
   on the iOS phone shell.
3. **Actions.** The descriptor's `actions`, `nessie:screen-action`, the primary
   text button and the overflow sheet, `submit`/`selected`/link handling.
4. **Motion.** `nessie:screen-transition` from `startTransition`, the two-layer
   animated bar, native reduced-motion. (Swipe tracking is a follow-up — §8.)
5. **Edges.** `/channels/new`, the designer's title input, focus-mode palette,
   cold-start blank bar, and a sweep of every screen header for pages that drew
   extra chrome of their own.

## 12. Tests and docs

- `mobile/src/lib/native-shell-layout.test.ts` — the constant-band invariant as
  a test: for every screen type the iOS phone frame inset is the same number,
  and the Android answers are unchanged.
- `mobile/src/components/native-nav-bar.test.ts` (new) — lane composition from
  the descriptor (including "a published `back` wins over `screenType`"); the
  action partition, with the "nothing is dropped" property.
- `mobile/src/lib/native-shell-message.test.ts` — guards for the new messages,
  including rejecting malformed action payloads.
- `admin/test/screen-header.test.ts` — the iOS-phone branch renders no visible
  bar, still publishes, still renders one `h1`, still renders the `below` slot;
  the widened source gate; the non-iOS branches untouched.
- `admin/test/native-touch-navigation.test.ts` — `screen-transition` is posted
  from the layout effect, before the screen message, on `single` only.
- A test that a `NestedStage` publishes its own descriptor and that the bar
  therefore leaves root lanes — the defect §5.1 names.
- `admin/e2e/navigation/cases/phone-back.mjs`, `phone-edge-swipe.mjs` — stay
  green unchanged; they pin the web stack, which this does not alter.

Docs: `docs/navigation/native-shell.md` §10 gains the new messages, the
per-layer descriptor and the constant-band invariant;
`docs/navigation/deep-links-and-headers.md` §9 gains the iOS-phone rendering
and the rule that a screen header is the only thing that may draw one. Both
change in the same turn as the code.

## 13. Verification

- **Mobile Safari is unchanged**: Playwright at `http://localhost:5455` in a
  phone viewport, screenshots of a root and a detail compared against `main`.
  This is the acceptance test for the "iOS only" constraint.
- **The native shell**: iOS Simulator. Screenshot a tab root and a conversation
  and confirm the band is the same height in both. Then measure the defect
  directly, in both directions: drive a partial back-swipe with a touch path
  and screenshot mid-gesture, confirming the revealed root's first row sits at
  the same y as after the commit; and tap a push, confirming no shift at the
  start of the transition either.
- Root, detail, nested stage (a Knowledge document *and* its editor), a tab
  host (a conversation's Files tab), the conversation-info flow, a Flow
  (`/channels/new`), a `submit` action (Notifications' Save preferences), focus
  mode on and off, a cold start via push deep link, and rotation into and out
  of the landscape lane.
- VoiceOver: the native title carries `accessibilityRole="header"` and the
  chevron's `accessibilityLabel` is the effective Back label, so the heading
  survives in the native tree that now precedes the WebView.

## 14. Review record

Reviewed by Fable on 2026-09-05 (GO WITH CHANGES). Folded in:

- **Lane selection off `screenType` was wrong** for every nested stage — it is
  the pathname's registry type and a stage never changes the pathname (§5.1).
- **Publication keyed by pathname collides** where two headers share one route
  (`/channels/:id/info`); it is now keyed by layer (§5.1).
- **Four components draw headers outside the shared one** and publish nothing;
  the "one file, not 31" claim was false (§6).
- **`flowOwnsBack` screens** would have had the native chevron pop to the wrong
  place; the descriptor now publishes the effective Back (§5.3).
- **Action serialization was lossy** in ways that break behaviour — `submit`,
  `selected`, external links, `leading`/`eyebrow` (§7).
- **The ordering claim was inverted** for tapped transitions; the timing story
  is now stated per navigation kind (§1) and `screen-transition` posts from the
  layout effect (§8).
- **Frame-rate swipe streaming** would re-render the shell and the WebView per
  frame; deferred behind release-time animation (§8).
- **Slice 1 was not shippable** as written (§11).
- Cut: the bezier generalization (RN has `Easing.bezier`) and the
  FontAwesome→MaterialIcons table (text-first bar, overflow sheet).
- Corrected: reduced motion is not published by the web (§8); cold start must
  show a blank bar, not root lanes (§5.2); VoiceOver additions (§13).
