# Mobile app — WebView shell, push, TestFlight, Android

Chapter of [Running the Native Apps](overview.md).

The mobile app is a **WebView shell around the admin web UI** wrapped in native
chrome, mirroring the desktop app. `mobile/App.tsx` renders **one persistent**
`react-native-webview` that loads the admin, passing beneath a **native bottom tab
bar** (`react-native-bottom-tabs`; iOS 26 Liquid Glass on iPhone, Material on
Android) with five tabs — Channels · Projects · Knowledge · Admin · Search.
Agents now live **under Admin** (the Admin section's nav lists Agents/Activity/
Designer/Workflows/Triggers/Tools), and **Search** is the trailing tab (iOS 26
separated search role) backed by a global `/search` page. The bar is hidden on
the login / bootstrap screens. On iPhone and Android the bar sits at the bottom;
on iPad (iPadOS 26) `IpadNativeTabBar` renders the same destinations in a
lightweight native **top** row. Full-screen iPad places it flush below the top
safe area, while a Stage Manager window centres it in that window's title bar;
`App.tsx` keeps a 12-point clearance between that chrome and the WebView's first
row (`IS_IPAD`). The iPad deliberately does not mount `react-native-bottom-tabs`:
its empty tab scenes can cover the sibling WKWebView with a black controller
surface after login. Back, Forward, Recent Channels, Help, the destination tabs,
and Search form one centred, theme-derived native control group. The signed-in
person's SSO avatar is independently pinned at the trailing safe edge of the
top bar. The active workspace's public UOA picture (with initials as its failure
fallback) and name occupy the leading edge; in a
Stage Manager window that trigger first clears the system's leading window
controls. If the remaining space is tight, the workspace trigger flexes before
the centred group is reshuffled, reserving the avatar's space. That decision
uses the native chrome layer's measured width, rather than a cached orientation
value. The responsive sequence is: retain labelled controls, put Search and the
four toolbar actions in a native three-dot menu, then change the section tabs
to icons. The workspace trigger only truncates to its icon/chevron or hides as
a last resort. Tapping the workspace opens the web shell's existing workspace
menu, while tapping the avatar opens the canonical web account menu (presence,
status, settings, and logout), so neither native presentation forks the
entitlement-aware web actions.
Selecting an existing workspace stays inside the persistent WebView: the shared
menu calls Nessie's server-authorized UOA workspace-switch route and atomically
replaces the session. It does not open `ASWebAuthenticationSession`. Only
**Add a workspace** (and an exceptional target whose renewable proof is missing)
opens hosted UOA. For the exceptional switch, only the proof step leaves the
WebView: every terminal browser result is retained in a bounded native queue
until the web callback handler is ready, then the exact target is recovered and
the original in-app route is restored. Cancellation or failure keeps the
current session and workspace; it never sends the person through logout.
The duplicate web header trigger is omitted on native iPad and iPhone shells.
Tapping **Search** opens the full `/search` page
on iPhone and Android; on iPad it opens the native search overlay. The URL split
lives in `mobile/src/config.ts`:

- **dev** → `http://<YOUR-MAC-LAN-IP>:5455` (the admin Vite dev server; edits
  hot-reload on the device, and the admin's `/api` calls are proxied to the API)
- **prod** → `https://app.nessie.works` (the hosted admin)

Update the dev branch of `ADMIN_URL` to your Mac's LAN IP before building. The
old native app (login/channels screens) is archived at `archive/mobile-native`.

**External call links.** The mobile shell keeps its WebView on the configured
admin origin. Top-level links to Google Meet and Microsoft Teams open in the
system browser, as do Jitsi links for the shell's own
`EXPO_PUBLIC_JITSI_DOMAIN` configuration (default: `meet.jit.si`). Set that
build-time variable to the same hostname and optional port as
`NESSIE_JITSI_DOMAIN` for a self-hosted Jitsi deployment; it is deliberately
not accepted from the hosted admin page. Other non-Nessie top-level origins are
blocked rather than treated as generic external links, while embedded content
continues to load normally.

**Connector sign-in.** Connecting an OAuth app from the iPhone or iPad WebView
does not use the native SSO `ASWebAuthenticationSession`: a connector provider
returns to Nessie's HTTPS callback, not an app deep link. The hosted admin sends
only the pending connector's authorization URL through the typed
`nessie:connector-authorization` bridge. Before calling `Linking.openURL`, the
native shell accepts only an absolute HTTPS URL with a host and no embedded
credentials; this dynamic authorization capability is separate from the fixed
allowlist for call links. The WebView remains on the configured Nessie admin
origin while the operating system browser shows the provider. On app foreground,
the shell explicitly notifies the pending Connect flow to re-fetch the app
status, so the dialog renders **Connected** once Nessie's callback has finished.
Browser web keeps its normal centred `window.open` connector popup.

**Navigation bridge.** Neither tab surface hosts separate WebViews — each drives
the single WebView via the postMessage bridge. Tapping a tab calls
`window.__nessieNavigate(path)` in the SPA; the SPA reports route changes back as
`{ type: 'nessie:route', path }` so the selected tab resyncs. On the web side
this lives in `admin/src/providers/NativeShellBridge.tsx`, gated on
`isReactNativeWebView()` (`admin/src/lib/mobile-shell.ts`). In the native shell
the admin hides its own left rail and bottom tab bar. Phone-sized native layouts
also hide the admin top bar entirely; the iPad native layout hides that web top
bar too and exposes its remaining controls through `window.__nessieToolbarAction`
from `admin/src/layouts/admin-shell/NativeIPadToolbarBridge.tsx`, while global
search opens from the native Search tab overlay. Because that web top bar is
absent on iPhone, the native `App.tsx` frame reserves the status-bar inset for
every phone route — including tab roots whose content is not a direct admin
column — while `mobile/src/lib/webview-inject.ts` leaves full-screen web
surfaces clear of the home indicator. Status-bar indicators follow the actual
native backdrop (rather than WKWebView's optional colour-scheme value): the
phone header when present and the iPad's native root frame otherwise. Light
surfaces therefore use dark icons. The iPhone tab controller uses its
transparent scroll-edge appearance, and is constrained to the tab-bar overlay,
so it stays above the WebView without intercepting the page. This lets the
glass blur the content actually scrolling beneath it without a second tinted
bar behind the controls. Every phone route has a page-shell end spacer equal to
the tab-bar height plus the home-indicator inset; nested vertical scrollers
receive the same internal inset. This covers full-height and horizontal layouts
as well as ordinary lists. It never shortens the page or sidebar surface:
content continues behind the glass while the final row can scroll above it. iPad and Android
reserve their top inset in the native frame. Android's
floating dock has no independent separator: the shared dock-geometry contract
adds its exact interaction clearance to the WebView columns, keeping the chat
composer entirely above the dock while page backgrounds continue beneath it. The
per-section secondary sidebar (channel list, admin sub-pages, …) opens from a
**top-left hamburger** as a slide-in drawer. Mobile *web* (a phone browser, no
native shell) gets an equivalent web-rendered bottom tab bar instead — and, like
the native phone layout, hides the admin top bar entirely whenever that bottom
tab bar is shown (`hideTopBar` in `AdminShellLayout.tsx`). Global search is
reached from the bottom bar's **Search** tab, and each page renders its own
mobile header (hamburger + title) for drawer access. Where that top bar is
hidden, the mobile header also provides the signed-in user's canonical account
control: the same avatar, presence/status badges, and account menu used at the
bottom of the desktop rail. A shell with that rail never renders a second
top-bar account badge.

On the native iPhone and Android first screen of **every tab** (Channels,
Projects, Knowledge, Admin, and Search, including ordinary query-string state),
`NativePhoneConversationMenuChrome` adds a workspace header above the retained
WebView. Its surface is the same `--rail` backing surface visible beneath the
transparent iPad tab controls, and its controls use the theme's `--tx` colour;
in particular, the default Sandstone header is the same warm light beige as
that iPad background. On a portrait phone, the team/workspace switcher is at
the leading edge and the signed-in account is pinned at the trailing edge;
navigation controls stay out of that constrained header. An eligible Max-class
iPhone in landscape shows a shorter 46-point header on **every** page, including
detail pages alongside the fixed menu: workspace, Back, Forward, Recent Channels,
then account. Search is still deliberately not duplicated there: it remains the
dedicated bottom-tab destination. The workspace control opens the existing
entitlement-aware switcher, every toolbar button delegates to the existing
toolbar bridge, and the account control opens the canonical account menu. When
that landscape layout rotates back to portrait from a detail page, the shell
returns to that section's menu instead of stranding the user on the former
right-hand page. Its compact header uses a 32-point horizontal gutter, matching
the floating tab controls so neither the workspace nor account action crowds a
landscape screen corner. The header owns the status-bar backdrop, so its system
indicators follow the header's actual contrast. Its Slack-positioned
bottom-right **+** is deliberately limited to the Channels root: it uses the
theme's darker primary colour (`--accent-strong`) and expands directly into the
highlighted **Message** action. The surrounding native sheet and its compact
**Project** and **Channel** choices fade and grow around that action. **Project**
replaces Slack's Huddle, **Channel** remains a regular row, and **Message**
opens a direct message. Each delegates to the same web-shell handler and dialog
as the sidebar, rather than creating a second permission path. The Channels,
Projects, Knowledge, and Admin WebView sidebars each carry
the native-touch marker on iPhone, iPad, and Android, so those installed
interfaces use the same Slack-scale 38-point rows and 14px menu type while
desktop remains compact even on a touchscreen. Project folder rows alone are
bold. Human, agent, and workspace avatar tiles use the same subtly rounded
square shape everywhere. Human avatar
presence badges use a three-pixel cutout that matches the sidebar background.

The same page-rail workspace header appears at the first screen of every tab in
mobile Safari and Android browsers. Its workspace, Recent Channels, and account
buttons are the existing shared web controls, not browser-specific copies; the
mobile browser still owns its own system and address-bar chrome. Where the
normal top-bar **Help & feedback** icon is absent, the same **Help & feedback**
route is available from that right-hand account menu.

The native **Admin** sidebar ends with a native-only **Full refresh** action on
iPhone, iPad, and Android. It remounts the embedded WebView at the current
route and adds a cache-busting URL marker, so it can recover stale or failed
hosted content without adding an equivalent control to the browser UI.
Participant-named conversation rows retain the complete participant list in a
custom HTML hover tooltip, whether they appear in Direct messages, Projects,
Channels, or Starred. Their visible label is measured in the sidebar: complete
names are shown first, then surnames collapse to initials, then the first names
that fit followed by an ellipsis and a `+N` count. The tooltip lives outside the
scrolling sidebar and has no pointer events, so a touch still opens the
conversation on its first tap. Project and channel action popovers use a 12px
container radius with a padded, 8px-radius action row so their choices do not
feel cramped.

The login route is its own full-height touch-scroll container because the page
root remains fixed for the authenticated shell. On phone widths it presents the
sign-in panel before the welcome panel, keeping hosted SSO visible without an
initial scroll; desktop keeps the two-column welcome/sign-in order.
On the hosted web app, UOA still returns to the byte-exact `/login?code=…`
redirect URI, but that route immediately replaces itself with
`/login/completing?code=…`. The dedicated **Finishing sign-in…** surface owns
the exchange and then replaces itself with the destination, so neither the
interactive login form nor the callback remains in browser history.
Native SSO reports every terminal `ASWebAuthenticationSession` result back to
that login surface. A successful deep link continues through the existing PKCE
exchange; closing or dismissing the iOS sheet clears the pending PKCE attempt
and restores the provider button without showing an error. A native session
failure also restores the button and shows a retryable message. The native
callback remains queued until the SPA acknowledges it; returning the app to the
foreground immediately replays any unacknowledged result. No elapsed-time
fallback decides whether authentication succeeded.

The installed mobile login also has the authenticated app's bug icon in its
lower-right safe area. It opens the same Session debug panel with an empty JSON
textarea. Paste the JSON copied from **Session debug** on another signed-in
Nessie device and choose **Sign in with session** to use that session's current
access bearer. The target app checks that the dump names the same configured
API, validates the bearer with `/api/auth/me`, and trusts only the server's live
identity response; it never restores or uploads the dump's claims, cookies,
local storage, or user/context fields. This is temporary debug access: the
httpOnly refresh credential cannot be copied, the imported bearer is never
renewed, and the app clears it at JWT expiry. It does not register the device
for that user's push notifications. Imported access stays in the workspace
encoded by the copied bearer; copy a new dump from another active workspace
rather than switching inside the target app. Signing out clears only the
imported bearer and does not act on an unrelated WebView refresh cookie.

**Lifecycle and session persistence.** Moving the native app to the background
and foreground again preserves the existing WebView instead of navigating or
remounting it on a timer. This keeps the current route, DOM storage, and WebKit
cookie store intact so a normal app switch does not restart session bootstrap or
race refresh-token rotation. Recovery remains event-driven: iOS reloads only
after WebKit reports that its content process terminated, Android remounts after
its render process is gone, and the capped boot watchdog retries genuinely
blank or failed page loads.

**Feedback without motion access.** The mobile shell does not subscribe to
accelerometer data, so iOS/iPadOS does not ask for the broad “Motion & Fitness
Activity” permission at launch. Feedback remains available through Help and
Feedback on iPad and the admin Feedback section on every form factor.

`react-native-webview` and `react-native-bottom-tabs` are native modules, so
**Expo Go cannot host the app** —
you need a prebuilt build (`npx expo prebuild` regenerates `mobile/ios` /
`mobile/android` with autolinking). Building for a physical device requires Apple
Developer signing.

For **developer work only**, start the local admin/API and build a development
client. This is deliberately a different path from putting a working Nessie
app on someone's phone: it opens the Expo launcher and needs Metro while it is
being used.

```sh
# 1. Run the admin + API dev servers (repo root); the admin must be LAN-reachable.
pnpm dev                      # API :5454, admin :5455

# 2. Build + install a Metro-dependent development client:
cd mobile
npx expo run:ios --device     # prebuild + pods + build + install + launch + Metro
```

On Xcode 26 the Expo installer can hang at "Connecting to device". If so, build
and install manually after `expo prebuild`:

```sh
cd mobile/ios
xcodebuild -workspace Nessie.xcworkspace -scheme Nessie -configuration Debug \
  -destination "id=<DEVICE-UDID>" -allowProvisioningUpdates build
# then locate Nessie.app from the build log and:
xcrun devicectl device install app --device <DEVICE-UDID> <path/to/Nessie.app>
xcrun devicectl device process launch --device <DEVICE-UDID> com.km.nessie
```

### Direct device deployment requests

When someone asks to deploy a Nessie build to a named physical phone, tablet,
or other device, the requested outcome is **build, install, and launch on that
device**. Uploading an artifact or sending an installation link is not a
completed deployment.

For a connected iPhone or iPad, build the `device` profile, retrieve
the resulting archive, install its `.app` through `xcrun devicectl`, and launch
`com.km.nessie`. Use the equivalent direct installer and launch command for
Android or desktop targets. Confirm that the exact device is connected and
provisioned before the build; if it is unavailable or cannot accept the
signature, report that concrete blocker instead of treating an artifact URL as
the handoff.

Unless the request explicitly asks for Metro hot reload or an Expo development
client, an internal physical-device deployment uses the `device` EAS profile.
It launches the normal Nessie WebView shell directly. The `development` profile
opens the Expo development launcher and is not a substitute for a usable app
deployment. This is the default physical-device delivery policy stated at the
top of this guide.

Treat the deployment as complete only after verifying all of the following:

1. The target is the intended physical device (match its hardware UDID and
   model, not only its friendly name) and the signing profile includes it.
2. The installed app is the build just produced, then it is terminated,
   launched in the foreground, and remains running.
3. A device screenshot shows the requested Nessie application screen. A
   successful install/launch command, a shared bundle ID, a TestFlight screen,
   or the Expo development launcher is not visual confirmation of the deployed
   app.

### Simulators & emulators (headless verification)

```sh
cd mobile
# iOS simulator (boot one first, e.g. iPhone 17 Pro):
npx expo run:ios --port 8082            # --port avoids the faces-metro clash on 8081
# Android emulator (boot an AVD first):
adb reverse tcp:8082 tcp:8082
npx expo run:android --port 8082
```

These commands build a development client and start Metro. The client honours
the selected Metro port; if the launcher appears, choose the running Nessie
development server. Do not use this path for a self-contained phone delivery.

Metro shares the data-volume fsevents problem (see Dev mode), so after editing
RN source restart it with `--reset-cache` for the change to be served.

The build outputs land at `/tmp/gpteen-xcode2/Prod/Debug-iphonesimulator/Nessie.app`
(iOS sim) and `mobile/android/app/build/outputs/apk/debug/app-debug.apk` (Android).

The WebView shows the admin's own login (SSO + local-dev email/password); there
is no separate native login. ATS allows the dev LAN `http://` origin via
`NSAllowsLocalNetworking` in `mobile/app.json`.

### Mobile navigation

The mobile shell keeps the native system tab bar as the primary section switcher
and leaves page data, URLs, and conversation state in the admin React app.

- On a **phone**, selecting or reselecting Channels, Projects, Knowledge, or
  Admin opens that tab's contextual navigation list first. Selecting an item
  then pushes its detail route in from the right while the list moves left. A
  conversation's Back control, browser/WebView Back, or tab-root navigation
  reverses that motion. This shared admin transition runs in both the iPhone
  and Android WebView shells (and narrow mobile web), and follows the system's
  reduced-motion preference. A forward push mounts its destination fully
  offscreen, gives the browser one painted frame to lay out and composite it,
  and only then starts the paired transforms. Navigation does not wait for
  network data: the destination's own loading state is prepainted instead of
  flashing into existence during its first moving frame.
- **Max-class iPhones** (a screen long edge of at least 900dp, such as iPhone
  16 Pro Max) permit landscape. While rotated, the native shell reports a
  dedicated large-phone landscape form factor: it retains the phone's bottom
  tab bar and Search destination, but the web workspace uses the adjacent
  iPad-style secondary menu and page columns. That secondary menu is a fixed
  260px column with no resize affordance. Smaller iPhones are locked to upright
  portrait, so they never enter a cramped two-column layout.
- A phone edge-swipe is owned by that same admin stack. The prior React screen
  remains mounted underneath the current one, so it is visible continuously
  under the finger with its scroll and component state intact. Native WebView
  history swiping is disabled on phone geometry to prevent the whole SPA from
  sliding over an empty host; tablet geometry keeps native history gestures
  because it never mounts the phone stack. Android hardware Back, the circular
  on-screen Back, and a completed edge-swipe all use the same history decision.
- A project selected from the phone **Projects** list opens its PM **Board**
  columns by default. A project selected from the **Channels** list still opens
  the project overview because that entry point supplies conversation context.
  Selecting a Knowledge space or product document view uses an addressable
  child route and pushes the shared Knowledge workspace over its list.
- Every phone route below its contextual list has one leading **Back** control,
  including project overviews opened from Channels. It returns to the route's
  immediate owning list (Channels, Projects, Dashboards, Knowledge, Apps, or
  Admin), so a direct link remains inside Nessie; tab roots retain the
  navigation-menu control instead. Stateful nested surfaces (Knowledge documents/history/editor
  and Admin column-browser details) reuse that one leading slot and unwind one
  local level before the route. Retained off-screen columns are inert and hidden
  from accessibility, so only the on-screen Back doorway is interactive.
- Conversation information is addressable at
  `/channels/:channelId/info`, with nested `/members` and `/members/add`
  destinations. This gives a cold deep link the same deterministic Back path
  as an in-app navigation sequence.
- **iOS** uses the translucent circular conversation Back affordance alongside
  the system Liquid Glass tab bar. **Android** uses the same routes and
  hierarchy, but keeps its normal Material-style Back affordance rather than
  imitating iOS glass.
- **iPad, Max-class iPhones in landscape, Android tablets with a multi-column
  viewport, and desktop** retain
  their side navigation beside the selected detail and never mount the phone
  transition viewport; conversation information is an inspector, not a
  phone-style replacement.

## iPhone Dev Build And Direct APNs Push

Nessie sends iOS notifications **directly from its own worker/API to APNs**. It
does not use Expo Push. The iOS app registers its raw APNs token after an
authenticated WebView route loads; the authenticated admin then stores that
token with the current organization. A notification tap returns to the exact
channel message when its deep-link target is still available. On a cold launch,
the native shell caches that target before creating the WebView and the React
navigation bridge reads it only after the router has mounted. The SPA root
redirect also selects that cached target before its ordinary `/channels`
landing route runs, so the default Personal Assistant conversation cannot
replace the notified conversation. The target remains cached until the SPA
reports that exact route back, then is cleared to prevent reopening an old
message later. Direct APNs routing metadata is carried in the top-level
`body` object: Expo serializes that remote `userInfo.body` as
`NotificationContent.data`, which is the native bridge's actionable payload.

### Simulator deep-link replay

Use the maintained APNs fixture and WebView route harness to prove both a cold
notification tap and a warm tap without waiting for a live agent reply. Start
the harness and Metro with its URL, then use `simctl push` with
`mobile/test/fixtures/cold-deeplink.apns`; the harness renders the exact path it
acknowledges back to the native shell. This exercises the same APNs custom data
shape and native notification-response bridge as production:

```sh
pnpm --filter @nessie/mobile test:deeplink-simulator
EXPO_PUBLIC_ADMIN_URL=http://YOUR_MAC_LAN_IP:5462 pnpm --filter @nessie/mobile start -- --dev-client
xcrun simctl push <simulator-udid> com.km.nessie mobile/test/fixtures/cold-deeplink.apns
```

For the cold case, terminate Nessie before sending and tap the system banner.
For the warm case, leave Nessie running on another path, send the same fixture,
and tap its banner. Both must render the fixture's full reply-thread URL; a
Personal Assistant route or an in-app banner destination is a failure.

Before a real-device build can receive pushes, an Apple Developer Account
Holder or Admin must do the one-time Apple portal setup for
`com.km.nessie`:

- Enable the **Push Notifications** capability on the App ID.
- Create an APNs **Authentication Key** (`.p8`) with its Key ID. Download it
  once and put it in the platform secret-management process; Apple does not
  allow it to be downloaded again.
- Record the Apple Team ID and use `com.km.nessie` as the APNs
  topic. The `.p8` key replaces APNs certificate files; it is valid for both
  sandbox and production hosts.

The application configuration includes Expo's `expo-notifications` plugin.
After `npx expo prebuild --platform ios --no-install`, confirm Xcode generated
`ios/Nessie/Nessie.entitlements` with `aps-environment`. Xcode's automatic
signing must use the Apple team whose App ID has the capability above. The
committed `mobile/app.json` pins Expo's `ios.appleTeamId` to that team so a
fresh prebuild keeps the same signing owner. The development profile reports
`sandbox` with its device token; the standalone `device`, TestFlight, and App
Store builds report `production`, and Nessie records that environment per token
so both can coexist.

The remaining prerequisites are:

- Apple Developer Program membership for device provisioning and the portal
  actions above.
- An Expo/EAS account for remote builds (optional for a local Xcode build).
- The `extra.eas.projectId` value in `mobile/app.json` filled by `eas init`.
- The `owner` value in `mobile/app.json` replaced with the Expo account name.

### Android FCM prerequisite

Android uses the same in-house sender, but Firebase issues the raw FCM token.
Before an Android production build can register or receive pushes for
`com.km.nessie`, add the Firebase project's `google-services.json` to the
mobile build configuration and upload the corresponding Firebase
**service-account JSON** through **Settings → Push credentials**. The first is
safe client build configuration; the second is the server credential used by
Nessie to call FCM directly and must remain in the encrypted server-side secret
store. Both files must belong to the same Firebase project and Android app ID.

Build the standalone `device` profile for a physical phone or tablet:

```sh
cd mobile
pnpm build:device:ios
```

The build opens Nessie directly at `https://app.nessie.works` and can register
an APNs token; it does not need Metro. The `development` profile remains
available only for deliberate debugging work with a running Metro server.

For Android use:

```sh
cd mobile
pnpm build:device:android
```

The legacy `preview` profile extends `device` and remains equivalent for an
already-running release pipeline.

### Configure and prove the in-house sender

1. Sign in to Nessie on that physical iPhone or iPad and grant notification
   permission. This registers the native APNs token for the signed-in user and
   current organization. Every signed session has a globally ordered,
   server-issued registration generation, so out-of-order former-session
   requests — including those from a former account — cannot reclaim it. Logout
   retains a non-deliverable tombstone with a newer generation for the same
   reason. A simulator cannot prove APNs delivery.
2. Sign in as a platform super-admin, open **Settings → Push credentials**, and
   upload the `.p8` key with its Key ID, Team ID, topic
   `com.km.nessie`, and either environment. The secret is encrypted
   in Nessie's server-side secret store and is never returned to a client.
3. Select **Send test to this iPhone**. Nessie looks up only the operator's
   newest iOS token in the current organization, selects that token's APNs host
   (`sandbox` or `production`), and sends a real alert directly to APNs. An
   “APNs accepted” response is provider acceptance, not a claim that iOS
   displayed the banner.
4. Send a channel message. The worker sends the sender as the notification
   title and the destination as a `# channel` context (an APNs subtitle, composed
   into the Android/browser title); a direct mention keeps its explicit
   “mentioned you in # channel” subtitle. This is followed by a whitespace-normalized,
   truncated message preview (at most 140 characters). It coalesces bursts by
   the main channel feed or the individual reply conversation and carries that
   exact `/channels/:channelId/threads/:threadId/replies/:rootMessageId` link.
   Muted channels and quiet-hours remain suppressed. Tokens from another
   organization are never selected. For a live agent turn, leave that exact
   thread before its terminal reply: the requester receives one completion
   notification per run. A reply based on restricted sources is rechecked
   against live membership and disclosure grants immediately before delivery
   and uses only the generic body “An agent reply is ready.” Every native and
   browser push also carries that recipient's current total badge: unread
   channel messages plus visible assigned-work and knowledge attention. This is
   an absolute total, never a per-notification increment, so a later
   task/knowledge push cannot overwrite channel unread badges.

For a production check, repeat step 3 with a TestFlight build. It must reach
the production APNs host; a sandbox development token must not be sent there.

### Per-user delivery controls and open-page suppression

Each person controls their own delivery at **Settings → Notifications**. All
important categories start enabled: channel messages, direct mentions, and
operational budget warnings/blocks for organisation owners. The account-level switch and quiet hours
remain a higher-priority stop for every category; a muted channel continues to
suppress its channel and mention pushes.

Every visible Nessie browser tab or native WebView sends a short-lived,
strictly ordered structured foreground surface heartbeat. Its channel target
contains the channel, its container thread, and either a null main-feed target
or the reply conversation's root message, and is accepted only for an active
organization member with channel access. Browser heartbeats additionally require
the window to have focus. Under the same per-user lock used for session
revocation, the API also verifies the heartbeat's exact refresh session is
still live. Before delivering, the in-house worker checks whether any of that
user's active sessions is already displaying the exact channel feed, reply
conversation, or
operational-usage page the notification would open. If so, it does not send an
APNs/FCM/browser push—the realtime stream is already updating that destination.
A foreground **desktop or browser** client elsewhere in Nessie is not
suppressed: it receives its in-app banner and registered devices receive the
native delivery. The native iPhone/iPad/Android WebView does not render the
duplicate in-app message banner; its system push remains the notification
surface. A later
background signal wins over a delayed earlier foreground request, and `pagehide`
sends an unconditional null target. Backgrounded, unfocused, stale, revoked,
deactivated, and unrelated pages never suppress delivery; the API reaps expired
session records every five minutes. The selected-surface signal is shared with
the in-app banner: viewing Files, Info, or Runs in the same channel clears both
server delivery suppression and local-banner suppression.

Read state has the same precision as suppression. Each top-level post is the
root of its own reply conversation; opening reply A advances only A's cursor,
not reply B's. Opening the channel feed acknowledges its visible roots without
acknowledging their replies. Existing thread-wide read cursors remain a safe
baseline during the rollout, so deployment never reintroduces historical
unread items.

## iOS TestFlight

Follow the canonical [Apple TestFlight publishing guide](../publishing-apple-testflight.md)
for EAS setup, the local Xcode alternative, versioning, signing checks, and
internal TestFlight distribution.

## Android

For a standalone installed app:

```sh
cd mobile
pnpm build:device:android
```
