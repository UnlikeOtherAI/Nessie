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

