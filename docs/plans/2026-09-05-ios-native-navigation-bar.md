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
- **Two headers can share one pathname, and two screens can share one layer.**
  `/channels/:id/info` is a real route, but its layer renders the whole
  `ChannelsPage`: the channel's `ScreenHeader` *and* `ConversationInfoFlow`,
  which is `fixed inset-0 z-[80]` over it. The channel's header re-publishes
  whenever its title settles, so last-writer-wins puts "#design" and the
  channel's call/search/settings in the bar while the screen says
  "Conversation info". `ThreadReplyPanel` — a real depth-2 route rendered as a
  full-screen overlay from `ChannelOverlays` — has the identical shape.

So the admin publishes **bar descriptors per stack layer**, and within a layer
they form a **stack, not a slot**.

```ts
publishScreenBar(layerKey, handle, {
  title: string,
  back: { label: string, onBack: () => void } | null,
  actions: BarAction[],
})
```

`handle` is the publisher's own stable identity (a `useId()`), and it is not
optional: without it "topmost wins" cannot tell a re-publish from a new
publisher.

Three rules make that work, and all three are load-bearing:

1. **Key by `layerKey`, never by the route key.** The stack entry carries both:
   `key` is the classifier's `section:keyScope`, and `layerKey` is
   `section:depth:key` (`phone-navigation-stack.ts`). They differ for exactly
   the case that matters — `/channels/:id` and `/channels/:id/info` are both
   `channels:channel` and both alive in the stack at once, which is why the
   stack's own comment says identity "is section+depth+key … never the bare
   route key". The DOM attribute `data-phone-navigation-route` is the bare
   `key`, so it is **not** the handle to use. `PhoneNavigationLayer` provides
   `layerKey` through a `PhoneNavigationLayerContext`; a stage's layerKey
   embeds a section and depth that `NestedStage` cannot compute for itself, so
   the stage host returns it from `activate` (or exposes `layerKeyOf(id)`).
2. **Within a layer, the topmost publisher wins** — appended on first sight,
   **updated in place** thereafter, and removed only by an unmount cleanup
   keyed on `[layerKey, handle]`, with the live descriptor read from a ref.
   The bridge reads the top of that layer's stack, so `ChannelHeader` and a
   full-screen overlay coexist with no special case: the overlay publishes over
   the channel and the channel comes back when it closes.

   The update-in-place half is what makes it correct, and it is easy to get
   wrong by copying the local-back registry. That registry survives re-ordering
   only because precedence there is a numeric `priority` — its own comment says
   "mount order … can never flip Back ownership". Here order *is* precedence,
   and a publish hook that re-registers whenever its deps change runs its
   cleanup first: the delete-then-append moves the entry to the top. `ChannelHeader`
   takes ~20 live props and re-renders constantly under an open
   `ConversationInfoFlow`, so a re-registering hook would put the channel back
   over the overlay — the exact collision this rule exists to prevent. Hence:
   one append, updates in place, cleanup only on unmount.
3. **A stage publishes only from the instance that owns it.** §6 of the
   rulebook: a push over an open stage mounts the page again, so two instances
   render the same stage id, and only the one that pushed the entry may act on
   it. Without that gate, instance B's descriptor overwrites A's — and since
   `PageEditor`'s form id comes from `useId()`, a native Save would submit B's
   pristine draft over A's edits. `NestedStage` therefore provides
   `{ layerKey, owner }` from its existing ownership ref, and the publish hook
   is inert unless `owner`. (Route layers always own.) Note also that a header
   inside a stage reads the *route layer's* context, because the stage's
   content is portalled from the page's React position — the layerKey must come
   from the stage, not from context lookup. One consequence to implement
   deliberately: a stage's children run their effects *before* `NestedStage`'s
   own layout effect sets `owns`, so the first publish is inert. The
   `{ layerKey, owner }` value the stage provides must therefore change
   identity when ownership is taken — built fresh each render, or held in
   state — or the re-render that would let the real publish through never
   happens.

Handlers inside a retained descriptor go stale, so a publisher re-registers on
every render and the wire payload is compared by value before posting — exactly
what `sameScreen` already does for `nessie:screen`, so a re-render that changes
nothing posts nothing.

`publishScreenTitle` stays exactly as it is for `document.title`: that is a
per-pathname fact and is not changing.

`layerKey` is stable where it needs to be: `refreshPhoneNavigationRoute`
replaces the payload only; seeded cold-start layers keep their identity and a
later real navigation refreshes under the same key;
`dropPhoneNavigationEntriesAboveCurrent` only removes, and a dropped layer
retires its own key on unmount. The one reuse is a same-depth sibling swap
(channel A → B), which is harmless: the header re-publishes the new title under
the same key and no transition runs.

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
render, as a label and the handler itself — and the native tap invokes that
published handler by layer key. The
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

**This is not one file.** Seven components draw screen-level phone chrome
outside `ScreenHeader` today, and none of them publishes anything:

| component | what it draws | fix |
| --- | --- | --- |
| `ConversationInfoFlow` `FlowHeader` | 58px `<header>` + `<h1>` + `PhoneNavigationButton` | convert to `ScreenHeader` |
| `ThreadReplyPanel` | a real depth-2 route drawn as a full-screen overlay, own `<header>` + `PhoneBackButton` | publish over its layer (§5.1 rule 2) |
| `AgentScreenPanel` | `fixed inset-0` local-back owner, own `<header>` + `PhoneBackButton` | publish over its layer |
| `DashboardWorkspacePanel` | `fixed inset-0` local-back owner, own `<header>` + `PhoneBackButton` | publish over its layer |
| `KnowledgePane` | `ResponsivePageHeader` with `onBack` | publish per stage key; Cancel/Save become bar actions |
| `WorkflowDesignerHeader` | `ResponsivePageHeader` with `titleInput` | see below |
| `ColumnBrowserColumn` | 50px row + `PhoneNavigationButton` + `h3` | publish per column stage key |

The three full-screen overlays are why §5.1's within-layer stack exists: they
are not stages and not routes of their own layer, so a slot would leave the bar
showing the conversation beneath them.

`WorkflowToolbar` also renders a `ResponsivePageHeader`, but as
`titleTone="section"` — a `SectionLabel as="h2"` inside a page, no `h1` and no
doorway. It is a section header, out of scope, and stays.

**The source gate targets the signature that actually escaped**, not a blanket
sweep. `admin/test/screen-header.test.ts` walks `admin/src/pages` only, which is
how all seven escaped; widening it to any `<header>` or `<h1>` under `admin/src`
would fail on legitimate code — `MessageMarkdown` renders an `h1` from user
markdown, and `PagePreview`, `FileNodeViewer`, `BootstrapPage` and `NotFoundPage`
each have honest ones. The gate instead fails on:

- `PhoneNavigationButton` or `PhoneBackButton` rendered outside `ScreenHeader`
  and `ResponsivePageHeader`, and
- `ResponsivePageHeader` rendered outside `ScreenHeader` without
  `titleTone="section"`,

against an allowlist that only ever shrinks. That catches exactly the seven and
nothing legitimate.

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

- A **`submit`** tap posts back and the web calls `requestSubmit()` on the
  named form — not `onSelect`. It is looked up with `getElementById`, never a
  `querySelector`: those ids come from `useId()` and contain colons, which are
  not valid in a CSS selector. One caveat travels with this: Notifications'
  save relies on the submit being a **user gesture** to ask for notification
  permission (Safari rejects off-gesture requests), and a `requestSubmit()`
  driven from a bridge message has no transient activation. Native push
  registration is the shell's own path anyway, so that call is gated on
  `!isReactNativeWebView()` and the comment there says why.
- **`selected`/`pressed`** render as a filled bar button, so a live call or an
  open search still reads as on.
- A **`link`** with `target: '_blank'` goes through the existing
  `nessie:open-external` path, never a native `href` follow.
- **`tone`** and **`priority`** survive only as ordering and emphasis in the
  sheet; in a text-first bar they decide nothing else.
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
   stage pushes and pops. `from`/`to` are layer keys.
2. **The bar will not always have the incoming descriptor when the transition
   starts.** On a forward push the children of the new layer are captured in
   that same layout effect, so the `to` layer has not mounted and its header
   has not published yet. The real wire order on every tapped push is
   `screen-transition(to: no descriptor yet)` → `nessie:screen` →
   `descriptor(to)`, all inside one JS task and before the web's first
   animation frame. The native reducer is designed for exactly that: a
   descriptor arriving for the in-flight `to` key **fills the incoming layer
   without restarting the animation**, and an incoming layer with no descriptor
   yet renders blank — never root lanes. A pop is the easy direction: the
   target is retained, so its descriptor already exists, which is why the
   reported case works by construction.
3. The native bar treats a `nessie:screen` arriving **while a transition is in
   flight** as the transition's target, never as a reason to snap.
4. **`startTransition` does not cover everything.** It is not called for a
   swipe-committed pop (the viewport suppresses the animation it already ran),
   for an in-place sibling swap, for a cross-section reset, or when there are
   not two layers. So: slice 4 hands the `from`/`to` layer keys into
   `usePhoneBackSwipeGesture` — which today knows only DOM layers — so the
   settle can post its own `screen-transition`; and every no-transition case
   snaps on `nessie:screen`, which is correct because nothing is animating.
5. The post is gated on `layout === 'single'`, or the landscape `split`
   viewport would post its column pushes as if they were the bar's.
6. **The bridge needs the current layer key, and today it cannot see one.**
   The native reducer selects descriptors by `layerKey`, but `nessie:screen`
   carries none and `PhoneNavigationProvider` exposes neither the stack nor the
   current entry to the bridge. The viewport therefore publishes its current
   `layerKey` into the same store the bridge subscribes to (as `useScreenTitle`
   already does for titles), and `nessie:screen` gains `layerKey` beside its
   existing fields. This is the first thing slice 2 hits.
7. A tapped push posts `nessie:screen` **twice** — once with an empty title,
   once when the incoming header publishes. Both are absorbed into the
   in-flight target by rule 3; the native test asserts that explicitly.

Natively, the bar renders two content layers — outgoing and incoming — and
drives `opacity` and `translateX` with `Animated` (`useNativeDriver: true`):
the title slides a short distance and crossfades, the chevron and its label
fade. Curve and duration are `NAV_MOTION`'s — `Easing.bezier(0.22, 1, 0.36, 1)`
at 300ms. **React Native already solves this bezier**; `chrome-transition.ts`'s
solver is the Android and iPad focus-mode curve and is not touched.

Reduced motion is read natively from `AccessibilityInfo.isReduceMotionEnabled()`
and its change event. The web does not publish it and never did.

Whether the two-layer animated bar is worth its complexity is decided **on
device, in slice 4**: if the bar's contents cannot be kept in visible sync with
the layers, §10's web-drawn fallback is the answer and this machinery comes
out. The check is named there rather than left to taste.

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
   every conversation. The surface is `phoneHeaderSurface`, not the page
   background: the status-bar style is derived from the header surface while a
   header shows, so a differently coloured band would trade the geometry jump
   for a colour snap at the same moment. The jump is gone and measurable here.
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
- `admin/test/nested-stage-viewport.test.ts` — the **two-instance** case, which
  it does not cover today: a route pushed over an open stage mounts the page
  again, and only the owning instance's descriptor may stand. Without this the
  `useId()`-keyed form of a second `PageEditor` can be submitted over the
  first's edits.
- A test that two publishers in one layer stack rather than overwrite
  (`ChannelHeader` + `ConversationInfoFlow`), that closing the overlay restores
  the channel's descriptor, and — the case a re-registering hook would fail —
  that re-publishing the channel header while the overlay is open leaves the
  overlay on top.
- `native-nav-bar.test.ts` pins the push wire order — `screen-transition`
  without a `to` descriptor, then `nessie:screen`, then the descriptor — and
  that the incoming lane stays blank rather than falling back to root lanes.
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

### Round two (Fable, 2026-09-05) — GO WITH CHANGES, folded in

Round one's findings verified as genuinely closed except the pathname
collision, which was closed in the wrong place. Round two's blocking items,
each verified against the code before acceptance:

- **The layer key named in §5.1 was the wrong one.** `data-phone-navigation-route`
  is the classifier's bare `key` (`section:keyScope`), which `/channels/:id`
  and `/channels/:id/info` *share* while both are alive; the stack's own
  identity is `layerKey` (`section:depth:key`) and its comment says never to
  use the bare key. Keying by the attribute would have reproduced exactly the
  collision the section was written to fix.
- **The collision is inside one layer, not across two.** `ChannelsPage` renders
  the channel's header and a `fixed inset-0` overlay in the same layer, so
  per-layer keying alone changes nothing. Publication within a layer is now a
  stack with the topmost publisher winning (§5.1 rule 2).
- **Stage descriptors need the instance-ownership gate**, or a second mounted
  instance overwrites the first's — and with `useId()` form ids, a native Save
  submits the wrong form (§5.1 rule 3).
- **The incoming descriptor does not exist when a forward push starts.** §8 now
  states the real wire order and requires the native reducer to fill the
  incoming lane late without restarting the animation, and to render blank
  rather than root lanes meanwhile.
- **`startTransition` does not fire for swipe-committed pops, sibling swaps,
  cross-section resets, or single-layer cases** — named in §8 with what each
  does instead.
- **Three more stray headers**: `ThreadReplyPanel` (a real depth-2 route drawn
  as a full-screen overlay) and the `AgentScreenPanel` / `DashboardWorkspacePanel`
  local-back owners. Four became seven (§6).
- **The widened source gate would have failed on legitimate code** —
  `MessageMarkdown` renders an `h1` from user markdown. The gate now targets
  the Back-button and header components rather than `<header>`/`<h1>` (§6).
- **`requestSubmit()` from a bridge message has no transient activation**, and
  Notifications' save depends on the gesture to request notification
  permission; that call is gated off the native shell (§7). Form lookup uses
  `getElementById` because `useId()` ids contain colons.
- Slice 1's bare band must use `phoneHeaderSurface`, or the geometry jump is
  traded for a status-bar colour snap at the same moment (§11).
- Cut: `back.owner`, which nothing native consumed.

Adjudicated in the author's favour: §1's per-navigation-kind timing framing is
correct, and `WorkflowToolbar` is a section header and stays out of scope.

### Round three (Fable, 2026-09-05) — **GO**

All six of round two's items verified closed against the code. Two changes
folded in before implementation:

- **`publishScreenBar` needed a publisher handle.** The signature carried none,
  so "topmost wins" could not distinguish a re-publish from a new publisher,
  and the plan's "re-registers on every render" would have run a cleanup-then-
  append that lifts a re-rendering `ChannelHeader` back over an open overlay.
  Now: stable handle, append once, update in place, unmount-only cleanup. The
  local-back citation is corrected rather than kept — that registry tolerates
  re-ordering only because its precedence is numeric, which is exactly what
  this one's is not.
- **The bridge cannot see a layer key today.** `nessie:screen` carries none and
  the provider exposes no current entry; §8 item 6 names the store and the
  field.

Polish folded: the stage's ownership provider value must change identity when
`owns` is taken, or the first inert publish never re-runs; and the double
`nessie:screen` on a tapped push (empty title, then the real one) is asserted
absorbed.

Confirmed by review, not assumed: a pop leaves no blank frame — the retained
target's header is still mounted with its descriptor when `currentIndex` moves,
and the popped layer's publishers unpublish from a per-layer stack nobody reads
any more.
