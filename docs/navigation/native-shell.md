# The native shell contract

Chapter of [Navigation — how it is done](overview.md). §10: the messages the
web app and the native shells (`mobile/`, `desktop/`) exchange — screens,
attention, haptics, the back gesture — and who owns each decision.

## 10. Native shell contract — **built** (step 9 and the bridge pieces)

The `mobile/` ↔ admin bridge facts the plan (§4.7, §4.15, §4.16, §7) calls
out are **built**: Android hardware Back on every form factor, the haptic
bridge, `nessie:screen` and `nessie:attention`, and pull-to-refresh handed to
the web. The haptic call sites are the swipe commit (`light`), a committed
sheet swipe (`light`), a tab change (`selection`, never on a re-tap of the
selected tab) and the incoming-call ring (`warning`); nothing else buzzes.

- **The native back/forward swipe is off on every form factor** (plan §7,
  thrown only once `ScreenHeader` put a Back in every screen's leading
  lane). It is a WebView-wide switch that cannot be scoped to a column, and
  two owners of one edge gesture is the failure phones already fixed. Phones
  keep the admin's edge swipe; iPad and large-phone landscape use the header
  Back and the toolbar's history controls on the one ledger
  (`mobile/src/lib/webview-back-gesture.ts`).

- **`nessie:screen` — what screen the person is on.** Posted by
  `NativePhoneNavigationBridge` beside the unchanged `nessie:route` and
  `nessie:back-state`, so the shell stops re-deriving the tab from a
  hand-copied prefix list and can name the screen in its own chrome:

  ```
  nessie:screen {
    type: 'nessie:screen',
    path: string,
    title: string,
    section: 'channels' | 'projects' | 'knowledge' | 'admin' | 'search',
    screenType: 'root' | 'detail' | 'nested' | 'tabHost' | 'flow',
    depth: number,
    hasBack: boolean,
  }
  ```

  `section`, `screenType` and `depth` are read straight off the surface
  registry (§4.1) — the page type is `screenType`, not `type`, because `type`
  is the bridge's own message discriminant and one key cannot be both.
  `hasBack` is the one Back resolver's answer (§4) and `title` is the header's
  rendered title (§9). It is posted on every settled change of any field and
  on no re-render that changes none. The shell keeps a **last-known section**
  from the latest message, so its tab index is right before the first message
  on a cold start and after the search overlay closes.
- **The iOS phone shell draws the navigation bar natively.** Its band has a
  **constant height for the whole of a session past the auth gate** — no screen
  type, no transition state and no message may change it. That constant is the
  point: the WebView's own frame is derived from the band
  (`getNativeWebviewFrameInsets`), so a band that moved with the screen made
  the frame a function of navigation. It did, and the page jumped 64pt when a
  back-swipe committed — one whole animation after the motion it belonged to,
  because a swipe commits only once its settle has finished. (A tapped push
  resized at the *start* of its transition instead: same defect, two moments.)
  `shouldShowNativePhoneNavBar` is that constant;
  `shouldShowNativePhoneRootLanes` decides only what the band *carries*.
  **Screen-header replacement remains iOS-phone-only** — every rule in this
  bullet and the three below is gated on the iOS phone shell
  (`useNativeIOSPhoneApp`). Android keeps its team/account band on every screen
  with a tab dock, including details and tablet conversations beside a pinned
  list. Its screen title, Back and actions remain in the WebView. Full design and history:
  [`docs/plans/2026-09-05-ios-native-navigation-bar.md`](../plans/2026-09-05-ios-native-navigation-bar.md).

- **`nessie:screen-bar` — what the bar shows, per stack layer.**

  ```
  nessie:screen-bar {
    type: 'nessie:screen-bar',
    layerKey: string | null,
    title: string,
    back: { label: string } | null,
    actions: Array<{ id, label, kind, priority, disabled, primary, selected, tone, checked, items }>,
  }
  ```

  Keyed by the stack's `layerKey` (`section:depth:key`), **never** by a
  pathname and never by `screenType`. The two differ exactly where the bar has
  to be right: a nested stage never changes the pathname, so an open Knowledge
  editor over a space root reports `screenType: 'root'` and would be handed the
  team switcher; and a channel and its `/info` route share the classifier's
  bare `key` while both are alive in the stack. Within one layer the publishers
  form a **stack, not a slot** — a full-screen overlay (the conversation-info
  flow, a reply thread) publishes over its page's header and hands the bar back
  when it closes. `admin/src/navigation/screen-bar.ts` owns all of it.

  `back` is the Back the screen's **own header** would run, not the resolver's
  answer: a Flow that owns its Back returns to an address the registry cannot
  name. The chevron calls it through `__nessieScreenBarBack`. An action is
  described as data but performed through `__nessieScreenBarAction(id, itemId)`,
  because three of the four kinds do not simply call an `onSelect` — a `submit`
  action's work is in its form, a toggle inverts itself, and a link may leave
  through the shell.

  A layer that has not published yet — a cold start, the frame after a forward
  push — is a **bare band**, never the root lanes: a team switcher flashing
  above a conversation is worse than an empty band.

- **`nessie:screen-transition { from, to, direction, durationMs }`** — the
  stack is moving, so the bar moves with it. Posted from
  `PhoneNavigationViewport`'s `startTransition` (a layout effect, so ahead of
  the bridge's passive effect) on `single` only. The incoming layer has not
  mounted when it fires, so its descriptor arrives a render later and fills
  that lane **in place, without restarting the animation**. `startTransition`
  never fires for a swipe-committed pop — the viewport suppresses the animation
  the gesture already ran — so the gesture announces its own settle, with the
  duration of the travel that remains.

  A cancelled swipe posts no transition: the native header remained on the
  current screen during the drag, so announcing a parent-to-detail transition
  would flash a header for a screen the person never returned to.

- **The web draws no header there.** `ScreenHeader` renders no visible bar on
  the iOS phone shell, keeps its `h1` as `sr-only` (the settle focuses it and
  the live region reads it by `querySelector('h1')`, so removing the element
  would break the announcement silently), and keeps its subtitle/tabs row.
  Seven components draw screen-level chrome outside `ScreenHeader`; each
  publishes through `useNativeBarHeader` and hides its own header the same way.
  `admin/test/screen-header.test.ts` gates the doorway and page-header
  components across all of `admin/src` so an eighth cannot appear unnoticed.

- **`nessie:list-column { left, right, section }` — where the pinned list
  column stands.** Posted by `ResizableSidebar` (through
  `useNativeListColumnBridge`, `admin/src/layouts/admin-shell/native-list-column.ts`)
  on mount, on every `ResizeObserver` change, and on a window resize; a
  `section` of `null` retires it, which is what an unmount posts. The column
  is resizable and its width is a **per-section preference**, so the shell
  cannot derive any of it — only the document knows where the column ended
  up. `left`/`right` are viewport coordinates, which inside the WebView are
  the shell's own points, because the native frame gives the WebView the full
  window width. `isListColumnMessage` guards it and
  `native-shell-presentation.ts` keeps it as `listColumn`; a malformed message
  is refused rather than retiring the column on screen.

  **A full-bleed layer retires it too.** Native chrome cannot see a web
  overlay, and a modal covers the column without unmounting it — so a bridge
  that kept reporting geometry left the iPad's `+` floating over the
  full-screen browser, a control for a list that was no longer on screen.
  `useOverlay` holds a count for every open `kind: 'modal'`
  (`admin/src/navigation/full-bleed-layers.ts`) and the bridge posts the
  retired message while that count is above zero. A count, not a flag, because
  overlays nest: a dialog opened from inside a full-screen layer must not
  un-suspend the chrome when it closes.

- **The creation control is one component in two lanes.**
  `mobile/src/components/NativeCreationMenu.tsx` is the compose button that
  morphs into the sheet's Message row, and it is laid out inside whichever
  **lane** it is handed (`nativeCreationMenuMetrics`,
  `mobile/src/lib/native-creation-menu.ts`). The phone's lane is the screen,
  inset from both edges and standing on its tab bar; the iPad's is the pinned
  channels column from `nessie:list-column`, so the control lands against that
  column's own trailing edge rather than the window's. Both reach the admin
  through the same `__nessieCreateFromPhoneMenu` handler
  (`NativeCreationBridge`) — the wire name predates the iPad and installed
  builds still speak it — so create permissions and dialogs are identical on
  every shell. Which section the column belongs to is the **column's** answer,
  not the screen's: on an iPad the reader stands in a conversation while the
  channels list is still the column beside it. The shell publishes
  `--nessie-native-list-column-clearance` while the control is showing and
  `admin/src/styles.css` consumes it, so the column's last row stays reachable
  above a button that never moves.

- **`nessie:attention { badges }`** carries one unread count per section, keyed
  by the same registry section names (`{ channels, knowledge, projects }`
  today; a section the admin does not count is absent and reads as 0). It
  replaced the old `{ assignedWork, channels, knowledge, total }` shape, whose
  keys were a vocabulary of their own; `total` stays local to the admin, where
  the desktop and browser app badges read it.
- **Android hardware Back installs on every Android form factor.**
  `shouldInstallNativeBackHandler` (`mobile/src/lib/native-phone-navigation.ts`)
  is just `isAndroid` now — it used to also require the iOS-only
  `allowsBackForwardNavigationGestures` WebView prop to read `false`, and that
  prop happens to read `true` past the tablet breakpoint on Android too (where
  it has no effect), so an Android tablet had no in-app Back at all: the key
  backgrounded the app from any depth. Consumption is unchanged
  (`shouldConsumeNativeBack(hasBackDepth)` off the latest back-state — see
  `nessie:screen` below for what now feeds it). Android's predictive back
  gesture is opted in alongside it (`android.predictiveBackGestureEnabled` in
  `mobile/app.json`, per plan §7): React Native 0.81+ (the installed
  `react-native` is 0.83) moved `BackHandler` onto the invoked-callback-compatible
  path so the plain `hardwareBackPress` listener keeps firing with the flag
  on; the system's predictive-back preview only ever shows the launcher,
  never an in-app screen, and the in-app motion stays the web stack's.
- **Android runs full screen, and one published number owns its bottom edge.**
  Expo enforces edge-to-edge, which only moves the system bars *over* the app:
  on a tablet that still left the status bar across the top, the system
  taskbar — a strip of other apps — across the bottom, and both of them inset
  from the window. `modules/nessie-immersive` hides the bars outright
  (`WindowInsetsControllerCompat.hide(systemBars())`) and asks for
  transient-by-swipe behaviour, so an edge swipe shows them floating for a
  moment and they hide themselves again without ever insetting the window.
  Android forgets that request across a configuration change and on the way
  back from the background, which is why `App.tsx` re-applies it on both
  rather than calling it once at start-up. An installed build that predates
  the module degrades to the ordinary edge-to-edge window
  (`requireOptionalNativeModule`), never a crash.

  With the bars gone, the frame runs to the bottom of the window —
  `getNativeWebviewFrameInsets` returns `bottom: 0` on every platform now — and
  the floating dock (`AndroidTabletTabBar`) overlays the page rather than
  standing in a band below it. That is the whole point: a frame that ended at
  the safe-area inset left the page a taskbar's height short, with the dock
  floating in the gap, every full-height column — the chat's tool rail, the
  navy list column — stopping above it, and the composer held up off a floor
  that was not there. The page is told what the dock covers, and nothing else:
  `androidDockContentClearance` (`mobile/src/lib/android-tablet-dock.ts`)
  publishes the dock, its gaps and the safe-area inset as
  `--nessie-native-bottom-overlay`, zero on a route that draws no dock, and
  `admin/src/styles.css` owns every selector that spends it under
  `.admin-frame.has-native-android-shell`. Two rules there are load-bearing:

  - **`main` keeps its full height** (`padding-bottom: 0`). The clearance goes
    to the two things that own a page's floor — the channel composer and
    `PageBody`'s scroller — so a column beside them still reaches the screen.
    The iPhone's end spacer on `.phone-navigation-page` is deliberately *not*
    mirrored: that page is the whole content region on a phone but only the
    detail half of a tablet's two columns, where a spacer shortens the surface
    exactly as `main`'s padding did.
  - **`env(safe-area-inset-bottom)` is absent from those rules**, because the
    published value already carries it. The Android WebView reports the system
    bars' inset to CSS whether or not the native frame has accounted for it,
    and spending both is what left the tool rail a taskbar's height short of
    the floor.

  **The dock has two shapes, and orientation is the only thing that chooses
  between them.** `androidDockGeometry(landscape)` is the single answer —
  portrait is a 70dp pill lifted 8dp off the safe-area floor with each label
  stacked under its icon; landscape is a 50dp pill lifted 2dp with the label
  beside its icon. Sideways there is little height to spend, and the portrait
  pill and its gap took about a tenth of a 10-inch tablet's screen. Everything
  with a bottom measurement reads that one function — where the pill is drawn
  (`App.tsx`), how tall it draws itself (`AndroidTabletTabBar`), what the page
  reserves (`androidDockContentClearance`) and where the floating creation
  control sits (`getNativePhoneBottomChromeClearance`) — because a rotation
  that left any one of them holding the other orientation's number is the same
  defect as reserving a dock that is not drawn.

  The orientation is the **window's**, asked with `isLandscape` on
  `useWindowDimensions`, so a split-screen or freeform host is answered
  honestly rather than by the physical screen. It is deliberately not
  `largePhoneLandscape`: that flag gates the admitted iOS two-column lane and
  is false on every Android device by construction
  (`supportsLargePhoneLandscape` requires iOS). Nothing about the compact
  landscape header follows from this — that remains an iOS-only lane.

  Only the published number changes with orientation, never the stylesheet:
  `admin/src/styles.css` spends whatever `--nessie-native-bottom-overlay`
  carries, so the web and the iPhone are untouched and the rules above hold
  unchanged in both orientations.

  **The dock is glass over the live page.** The WebView sits in one
  `expo-blur` `BlurTargetView`, sampled by the dock's `BlurView` on Android 12
  and newer. A translucent theme-surface wash, fine highlighted rim and soft
  shadow keep labels readable over moving content. Older Android versions use
  a stronger surface tint instead of the costly legacy blur. The clipped glass
  sits inside the shadow host; neither changes the dock's geometry, interaction
  clearance, tab actions or badge counts. iOS keeps its system tab controller.

  **The soft keyboard takes the dock away, so the page stops reserving it.**
  `androidDockShowing` is false while the keyboard is up, which publishes a
  clearance of zero. The dock does not move for the keyboard — it stays at the
  window's floor, behind it — so on a device whose page shortens itself to the
  keyboard's top edge the reserved band becomes a hole between the composer and
  the keyboard. Measured on a Lenovo TB336FU: 86dp of it, which is the reported
  gap one taskbar smaller.

  The stylesheet's own `max(0px, overlay - (100lvh - 100dvh))` stays beside it
  and is deliberately belt-and-braces. It is the answer for a WebView that
  keeps its page at full height while the keyboard covers the bottom of it —
  there `dvh` shrinks and `lvh` does not. On the tablet above both units shrink
  together, so that subtraction is a no-op and the native signal is what
  closes the gap. Either way the two compose to zero rather than fighting.

  Browser coverage is `pnpm --filter @nessie/admin test:e2e:android-dock`; the
  immersive call, the frame geometry and the keyboard rule are unit-covered and
  were confirmed on the device by screenshot — a headless browser cannot show
  a system taskbar or a soft keyboard.
- **iOS: the WebView's own scroll view is off, and the keyboard has no
  accessory bar.** The document never scrolls — `body` is `overflow: hidden`
  at the live height and every scroller is an element inside it — so
  `MobileAdminWebView` sets `scrollEnabled` false on iOS. WKWebView gives its
  scroll view room as the keyboard rises, measured against the frame from
  before the shell ends it at the keyboard's top edge (`keyboard-overlap.ts`),
  so with scrolling on the whole page could be dragged up off the screen by
  its composer, and a reply thread was panned there on focus. With scrolling
  off, react-native-webview also resets any offset the keyboard forces.
  `hideKeyboardAccessoryView` removes WebKit's up/down/done bar on the iPhone
  and the iPad. Android keeps its scroll view: its page resizes instead.
- **iPad: the page reaches the window floor.** The shell marks the frame
  `has-native-ipad-shell`, which zeroes `.admin-shell > main`'s home-indicator
  padding. That padding left a band under every surface, and a detached
  thread panel — `position: fixed`, but inside `.phone-navigation-screen`,
  which clips — lost its composer's last 20pt to it. The floor's two owners
  clear the indicator themselves through `--nessie-native-home-clearance`
  (`env(safe-area-inset-bottom)` on that frame, unset elsewhere): the channel
  composer takes `max(14px, clearance)`, `PageBody` adds it to its padding. A
  docked keyboard ends the frame above the indicator, so both read 0 while it
  is up. The web, the iPhone and Android are unchanged.
- **`theme` and `bg` — the page publishes the chrome palette.**
  `NativeChromeThemeBridge` (`admin/src/bridges/`) renders an empty
  `.native-chrome-palette` element as a direct child of `.admin-frame` and
  posts `theme` (with `chromeSource: 'page'`) and `bg` read from it: on mount,
  on a `data-theme` change, on an organisation-palette change and on a focus
  toggle. `admin/src/styles.css` lists that element in every rule that gives
  the chrome its own palette — a theme's chrome scope (Nessie's navy) and focus
  mode — so a theme whose chrome differs from its work surface reaches the
  native header, the iPad chrome and the status bar **by CSS alone, with no
  native release**. The shell used to read `--rail`/`--tx` off the document
  root, which under such a theme is the white work surface: that is how the
  iPhone and iPad top bars stayed white under Nessie.
  `admin/test/native-chrome-theme.test.ts` fails a chrome rule that forgets
  the element.

  The iPad section strip uses the published `--accent` as a filled selected
  pill and the published `--on-accent` as its selected label/icon colour.
  Those two tokens are one contrast contract: tinting the pill and then
  reusing the accent for its text made the default Nessie theme render blue on
  blue. Inactive sections continue to use the chrome's muted foreground.

  `bg` is the colour *around* the WebView, and what that means depends on the
  form factor. An iPhone gets the chrome's `--main`, because `NativePhoneHeader`
  paints the whole top strip itself and the backdrop only shows through as
  overscroll; focus mode there hands over the work surface, so the frame keeps
  matching the page. **An iPad is the exception: its backdrop *is* its top bar.**
  `IpadNativeChrome`'s layer has no background of its own — the shell insets the
  page and floats translucent pills over whatever `bg` is — so an iPad always
  gets the chrome's `--rail`, focus mode included. Handing it focus mode's white
  work surface left dark pills on a white band with a charcoal sidebar beside
  them. `readNativeBackdrop` takes `ipad` for exactly this, and
  `admin/test/native-chrome-theme.test.ts` pins both halves.

  **The Tauri desktop window takes the same palette**, through
  `publishDesktopChrome` (`admin/src/lib/desktop-chrome.ts`) and the
  `desktop_set_chrome` command (`desktop/src-tauri/src/shell.rs`), which is why
  the bridge mounts for the desktop app as well as the native shell. Two things
  there are the window's to paint and not the page's: the flat colour a reload
  shows while there is no document — fixed in the bundle at `#2e1132`, the rail
  of the palette that was default before the Nessie theme, so every Cmd/Ctrl+R
  flashed purple — and the window's `NSAppearance`, which is what macOS draws
  the traffic lights and the screen-sharing control beside them in. Following
  the system rather than the page, that control rendered as a white block on the
  dark bar. The configured `backgroundColor` is now the default theme's chrome
  (`#0b172a`) for the window that exists before the page has published anything.

  The page sets `window.__nessieChromeThemePublisher`; the injected script
  (`mobile/src/lib/webview-inject.ts`) then posts neither message, and
  `applyNativeFocusChrome` shows a page-sourced palette as sent, keeping
  `NATIVE_FOCUS_CHROME` only as the fallback for an admin that predates the
  bridge. Installed builds without that check still post from the root for
  600ms after each change and the shell keeps the last message, so the bridge
  posts again after `REPOST_AFTER_LEGACY_SETTLE_MS` (700ms) until those builds
  are gone. When the shell unmounts (sign-out) the bridge posts the document's
  own palette once, without `chromeSource`, so the sign-in screen does not
  keep the chrome's or focus mode's colours: the injected script cannot take
  over by itself, because nothing it observes changes and its dedupe still
  holds the palette from before the bridge mounted. That hand-back is deferred
  a tick and skipped when a bridge has remounted in the meantime.
  `admin/test/native-chrome-theme-bridge.test.ts` mounts the real bridge.
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
- **`nessie:app-icon { icon }` bridge message.** Settings → Appearance shows
  an *App icon* panel (`admin/src/pages/settings/appearance/AppIconPanel.tsx`)
  only when `window.__nessieNativeShell.appIcon` is `true` — an iOS build that
  carries `mobile/modules/nessie-app-icon`. Picking *Dark* (the primary icon)
  or *Light* posts the message; `mobile/src/lib/native-app-icon.ts` guards it
  and `App.tsx` calls `setAlternateIconName`, then publishes the icon actually
  in effect back as `nessie:native-app-icon` (retained on
  `window.__nessieNativeAppIcon`, which the shell-info script also sets on
  every load). The panel shows that answer, not the tap.
  The light set is compiled into the asset catalog as `AppIconLight` by
  `mobile/plugins/with-light-app-icon.js`. Every icon and favicon is generated
  from one geometry by `assets/logo/generate.py`.
- **The shell stops re-deriving from the pathname what the admin already
  knows (step 9).** It used to match the WebView's reported `nessie:route`
  path against a hand-copied prefix table (`tabIndexForPath`, each
  `TABS[].matches` predicate, `isNativePhoneTabRootRoute`) to guess which tab
  a screen belonged to and whether it was a tab root — all now **deleted**.
  The admin posts, everywhere it posts `nessie:route`, a `nessie:screen`
  message read straight off the surface registry:

  ```
  {
    type: 'nessie:screen',   // the bridge message discriminant
    path: string,
    title: string,
    section: 'channels' | 'projects' | 'knowledge' | 'admin' | 'search',
    screenType: 'root' | 'detail' | 'nested' | 'tabHost' | 'flow',
    depth: number,
    hasBack: boolean,
  }
  ```

  (`screenType` carries the screen's own node type on the wire — a second
  field, distinct from the message's own `type` discriminant, which is always
  the fixed string `'nessie:screen'`.) `mobile/src/lib/native-shell-message.ts`
  `isScreenMessage` guards it; `native-shell-message-handler.ts` keeps a
  **last-known screen** `{ section, title, type, depth, hasBack }` in state
  (`mobile/src/lib/native-shell-layout.ts` `LastKnownScreen`,
  `DEFAULT_LAST_KNOWN_SCREEN` — the Channels tab, root, before the first
  message of a cold start arrives and after the search overlay closes). The
  selected tab index is `tabIndexForSection(lastKnownScreen.section)`
  (`tabs.ts`); the `TABS` table itself stays for titles, paths, and icons.
  Whether the current screen is a tab root — used for the native phone
  header/creation-actions affordance and, via `noteBackState`, hardware Back
  consumption — comes from `screenType === 'root'` / `hasBack`, never from
  matching a path. `nessie:back-state { hasBackDepth }` keeps working during
  the admin's transition to `nessie:screen`; once a `nessie:screen` message
  has arrived it is authoritative and a `nessie:back-state` arriving after it
  no longer overrides Back consumption.
- **`nessie:attention { badges: Record<section, number> }`** carries a badge
  count per tab section (`section` the same five-value union as above,
  replacing the earlier three-field `{ assignedWork, channels, knowledge,
  total }` shape). `isAttentionMessage` guards it;
  `native-shell-presentation.ts` `attentionBadges`/`nativeAttentionTotal`
  read `message.badges`, defaulting every section the admin has not reported
  — including one this build does not know about — to 0, and summing across
  `TABS` for the OS-level app badge rather than trusting a separate `total`
  field. The iPhone (`react-native-bottom-tabs`), iPad
  (`IpadNativeTabBar`/`IpadNativeChrome`), and Android tablet
  (`AndroidTabletTabBar`) tab bars all already had a badge slot; they now read
  `badgeCounts[tab.key]` directly instead of a three-way `channels
  | assignedWork | knowledge` mapping, so every section — including Admin and
  Search — can carry a badge once the admin posts one.
- **`nessie:account.language` selects native wrapper copy.** The account
  message carries the selected supported locale (`en-GB`, `en-US`, `cs`, `de`,
  `fr`, `it`, or `es`) alongside identity and presence. Mobile validates it,
  persists it in AsyncStorage for cold starts, and applies the matching native
  catalogue to tab labels, toolbar/accessibility labels, creation actions and
  the Android direct-update prompt. Before the first account message, native
  chrome uses `en-GB`; unsupported values are ignored. Tauri commands that
  show native confirmations or create a document window receive the same
  selected locale from the admin's `nessie.language` preference, with an
  `en-GB` fallback. Mobile catalogues live in
  `mobile/src/i18n/locales/<locale>/native.json`; desktop catalogues live in
  `desktop/src-tauri/locales/<locale>/native.json`. CI checks each set for
  matching keys.
